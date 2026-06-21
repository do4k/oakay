import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional, List

import aiosqlite
from fastapi import Cookie, Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

DB_PATH = os.getenv("DATABASE_URL", "/data/oakay.db")
SECRET_KEY = os.getenv("SECRET_KEY", "oakay-dev-secret-change-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

CURSOR_COLORS = [
    "#E05C5C", "#3A9E8A", "#4A7FD4", "#C47B2A", "#9B59B6",
    "#E67E22", "#1ABC9C", "#D4366E", "#2980B9", "#7D6608",
]


class ConnectionManager:
    def __init__(self):
        self._conns: dict[int, dict[str, WebSocket]] = {}
        self._info: dict[str, dict] = {}
        self._color_idx: dict[int, int] = {}

    def connect(self, ws: WebSocket, list_id: int, user_id: int, username: str) -> str:
        conn_id = uuid.uuid4().hex[:8]
        idx = self._color_idx.get(list_id, 0)
        color = CURSOR_COLORS[idx % len(CURSOR_COLORS)]
        self._color_idx[list_id] = idx + 1
        self._conns.setdefault(list_id, {})[conn_id] = ws
        self._info[conn_id] = {"user_id": user_id, "username": username, "color": color, "list_id": list_id}
        return conn_id

    def disconnect(self, conn_id: str):
        info = self._info.pop(conn_id, None)
        if not info:
            return
        list_id = info["list_id"]
        self._conns.get(list_id, {}).pop(conn_id, None)
        if not self._conns.get(list_id):
            self._conns.pop(list_id, None)
            self._color_idx.pop(list_id, None)

    async def broadcast(self, list_id: int, msg: dict, exclude: Optional[str] = None):
        dead = []
        for cid, ws in list(self._conns.get(list_id, {}).items()):
            if cid == exclude:
                continue
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self.disconnect(cid)

    def get_peers(self, list_id: int, exclude: str) -> list:
        return [
            {"connectionId": cid, "userId": info["user_id"], "username": info["username"], "color": info["color"]}
            for cid, info in self._info.items()
            if info["list_id"] == list_id and cid != exclude
        ]

    def info(self, conn_id: str) -> dict:
        return self._info.get(conn_id, {})


manager = ConnectionManager()


async def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")

        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS lists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT 'My List',
                position REAL NOT NULL DEFAULT 0.0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                list_id INTEGER,
                content TEXT NOT NULL DEFAULT '',
                checked INTEGER NOT NULL DEFAULT 0,
                parent_id INTEGER,
                position REAL NOT NULL DEFAULT 0.0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS list_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL,
                owner_id INTEGER NOT NULL,
                shared_with_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (shared_with_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE (list_id, shared_with_id)
            )
        """)

        # Migration: add list_id column if it doesn't exist yet
        async with db.execute("PRAGMA table_info(todos)") as cur:
            cols = {row["name"] for row in await cur.fetchall()}
        if "list_id" not in cols:
            await db.execute("ALTER TABLE todos ADD COLUMN list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE")

        # Migration: create default list for users with orphaned todos
        async with db.execute("SELECT DISTINCT user_id FROM todos WHERE list_id IS NULL") as cur:
            orphan_users = [row["user_id"] for row in await cur.fetchall()]

        for uid in orphan_users:
            cur2 = await db.execute(
                "INSERT INTO lists (user_id, title, position) VALUES (?, 'My List', 0.0)", (uid,)
            )
            list_id = cur2.lastrowid
            await db.execute(
                "UPDATE todos SET list_id = ? WHERE user_id = ? AND list_id IS NULL", (list_id, uid)
            )

        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(token: Optional[str] = Cookie(default=None)):
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(401, "Invalid token")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)) as cur:
            user = await cur.fetchone()

    if not user:
        raise HTTPException(401, "User not found")
    return {"id": user["id"], "username": user["username"]}


async def check_list_access(db, list_id: int, user_id: int) -> dict:
    """Returns list dict if user is owner or has share access."""
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, user_id FROM lists WHERE id = ?", (list_id,)) as cur:
        lst = await cur.fetchone()
    if not lst:
        raise HTTPException(404, "List not found")
    if lst["user_id"] == user_id:
        return dict(lst)
    async with db.execute(
        "SELECT id FROM list_shares WHERE list_id = ? AND shared_with_id = ?",
        (list_id, user_id)
    ) as cur:
        if not await cur.fetchone():
            raise HTTPException(403, "Access denied")
    return dict(lst)


# --- Models ---

class RegisterReq(BaseModel):
    username: str
    password: str

class LoginReq(BaseModel):
    username: str
    password: str

class CreateListReq(BaseModel):
    title: str = "New List"

class UpdateListReq(BaseModel):
    title: Optional[str] = None

class ShareListReq(BaseModel):
    username: str

class CreateTodoReq(BaseModel):
    content: str = ""
    list_id: int
    parent_id: Optional[int] = None
    after_id: Optional[int] = None

class UpdateTodoReq(BaseModel):
    content: Optional[str] = None
    checked: Optional[bool] = None

class MoveTodoReq(BaseModel):
    parent_id: Optional[int] = None
    position: float

class BulkPositionItem(BaseModel):
    id: int
    position: float


# --- Auth ---

@app.post("/api/auth/register")
async def register(req: RegisterReq, response: Response):
    username = req.username.strip()
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    pw_hash = pwd_context.hash(req.password)
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            cur = await db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, pw_hash)
            )
            await db.commit()
            user_id = cur.lastrowid
        except aiosqlite.IntegrityError:
            raise HTTPException(400, "Username already taken")

    token = create_token(user_id)
    response.set_cookie("token", token, httponly=True, max_age=TOKEN_EXPIRE_DAYS * 86400, samesite="lax")
    return {"id": user_id, "username": username}


@app.post("/api/auth/login")
async def login(req: LoginReq, response: Response):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?", (req.username,)
        ) as cur:
            user = await cur.fetchone()

    if not user or not pwd_context.verify(req.password, user["password_hash"]):
        raise HTTPException(401, "Invalid username or password")

    token = create_token(user["id"])
    response.set_cookie("token", token, httponly=True, max_age=TOKEN_EXPIRE_DAYS * 86400, samesite="lax")
    return {"id": user["id"], "username": user["username"]}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("token")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user=Depends(get_current_user)):
    return user


# --- Lists ---

@app.get("/api/lists")
async def get_lists(user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            "SELECT id, title, position FROM lists WHERE user_id = ? ORDER BY position, id",
            (user["id"],)
        ) as cur:
            own_lists = [dict(r) for r in await cur.fetchall()]

        result = []
        for lst in own_lists:
            async with db.execute(
                """SELECT u.username FROM list_shares ls
                   JOIN users u ON ls.shared_with_id = u.id
                   WHERE ls.list_id = ?""",
                (lst["id"],)
            ) as cur:
                shared_with = [row["username"] for row in await cur.fetchall()]
            result.append({**lst, "is_owner": True, "shared_with": shared_with, "shared_by": None})

        async with db.execute(
            """SELECT l.id, l.title, l.position, u.username as owner_username
               FROM list_shares ls
               JOIN lists l ON ls.list_id = l.id
               JOIN users u ON l.user_id = u.id
               WHERE ls.shared_with_id = ?
               ORDER BY l.position, l.id""",
            (user["id"],)
        ) as cur:
            shared_lists = [dict(r) for r in await cur.fetchall()]

        for lst in shared_lists:
            result.append({
                "id": lst["id"],
                "title": lst["title"],
                "position": lst["position"],
                "is_owner": False,
                "shared_with": [],
                "shared_by": lst["owner_username"]
            })

        return result


@app.post("/api/lists")
async def create_list(req: CreateListReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT MAX(position) as mp FROM lists WHERE user_id = ?", (user["id"],)
        ) as cur:
            row = await cur.fetchone()
        position = (row["mp"] or 0.0) + 100.0
        cur = await db.execute(
            "INSERT INTO lists (user_id, title, position) VALUES (?, ?, ?)",
            (user["id"], req.title.strip() or "New List", position)
        )
        await db.commit()
        async with db.execute(
            "SELECT id, title, position FROM lists WHERE id = ?", (cur.lastrowid,)
        ) as c:
            row = dict(await c.fetchone())
        return {**row, "is_owner": True, "shared_with": [], "shared_by": None}


@app.put("/api/lists/{list_id}")
async def update_list(list_id: int, req: UpdateListReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM lists WHERE id = ? AND user_id = ?", (list_id, user["id"])
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(404, "List not found")
        if req.title is not None:
            await db.execute(
                "UPDATE lists SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (req.title.strip() or "Untitled", list_id)
            )
        await db.commit()
        async with db.execute(
            "SELECT id, title, position FROM lists WHERE id = ?", (list_id,)
        ) as cur:
            return dict(await cur.fetchone())


@app.delete("/api/lists/{list_id}")
async def delete_list(list_id: int, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM lists WHERE id = ? AND user_id = ?", (list_id, user["id"])
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(404, "List not found")
        async with db.execute(
            "SELECT id FROM todos WHERE list_id = ? AND parent_id IS NULL", (list_id,)
        ) as cur:
            root_ids = [row[0] for row in await cur.fetchall()]
        for tid in root_ids:
            await _delete_recursive(db, tid)
        await db.execute("DELETE FROM todos WHERE list_id = ?", (list_id,))
        await db.execute("DELETE FROM lists WHERE id = ?", (list_id,))
        await db.commit()
    return {"ok": True}


@app.post("/api/lists/{list_id}/share")
async def share_list(list_id: int, req: ShareListReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM lists WHERE id = ? AND user_id = ?", (list_id, user["id"])
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(404, "List not found")
        async with db.execute(
            "SELECT id, username FROM users WHERE username = ?", (req.username.strip(),)
        ) as cur:
            target = await cur.fetchone()
        if not target:
            raise HTTPException(404, f"User '{req.username}' not found")
        if target["id"] == user["id"]:
            raise HTTPException(400, "Cannot share with yourself")
        try:
            await db.execute(
                "INSERT INTO list_shares (list_id, owner_id, shared_with_id) VALUES (?, ?, ?)",
                (list_id, user["id"], target["id"])
            )
            await db.commit()
        except aiosqlite.IntegrityError:
            pass
        return {"ok": True, "username": target["username"]}


@app.delete("/api/lists/{list_id}/share/{username}")
async def unshare_list(list_id: int, username: str, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, user_id FROM lists WHERE id = ?", (list_id,)) as cur:
            lst = await cur.fetchone()
        if not lst:
            raise HTTPException(404, "List not found")

        async with db.execute("SELECT id FROM users WHERE username = ?", (username,)) as cur:
            target = await cur.fetchone()
        if not target:
            raise HTTPException(404, "User not found")

        # Owner can remove anyone; shared user can remove themselves
        if lst["user_id"] != user["id"] and target["id"] != user["id"]:
            raise HTTPException(403, "Access denied")

        await db.execute(
            "DELETE FROM list_shares WHERE list_id = ? AND shared_with_id = ?",
            (list_id, target["id"])
        )
        await db.commit()
    return {"ok": True}


# --- Todos ---

async def _delete_recursive(db, todo_id: int):
    async with db.execute("SELECT id FROM todos WHERE parent_id = ?", (todo_id,)) as cur:
        children = [row[0] for row in await cur.fetchall()]
    for child in children:
        await _delete_recursive(db, child)
    await db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))


async def _compute_position(db, list_id: int, parent_id: Optional[int], after_id: Optional[int]) -> float:
    db.row_factory = aiosqlite.Row

    if after_id is not None:
        async with db.execute(
            "SELECT position FROM todos WHERE id = ? AND list_id = ?", (after_id, list_id)
        ) as cur:
            after_row = await cur.fetchone()
        if not after_row:
            return 100.0
        after_pos = after_row["position"]

        if parent_id is not None:
            async with db.execute(
                "SELECT position FROM todos WHERE list_id = ? AND parent_id = ? AND position > ? ORDER BY position LIMIT 1",
                (list_id, parent_id, after_pos)
            ) as cur:
                next_row = await cur.fetchone()
        else:
            async with db.execute(
                "SELECT position FROM todos WHERE list_id = ? AND parent_id IS NULL AND position > ? ORDER BY position LIMIT 1",
                (list_id, after_pos)
            ) as cur:
                next_row = await cur.fetchone()

        if next_row:
            return (after_pos + next_row["position"]) / 2
        return after_pos + 100.0
    else:
        if parent_id is not None:
            async with db.execute(
                "SELECT MAX(position) as mp FROM todos WHERE list_id = ? AND parent_id = ?",
                (list_id, parent_id)
            ) as cur:
                row = await cur.fetchone()
        else:
            async with db.execute(
                "SELECT MAX(position) as mp FROM todos WHERE list_id = ? AND parent_id IS NULL",
                (list_id,)
            ) as cur:
                row = await cur.fetchone()
        mp = row["mp"] if row and row["mp"] is not None else 0.0
        return mp + 100.0


@app.get("/api/todos")
async def list_todos(list_id: int, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await check_list_access(db, list_id, user["id"])
        async with db.execute(
            "SELECT id, content, checked, parent_id, position FROM todos WHERE list_id = ? ORDER BY position",
            (list_id,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


@app.post("/api/todos")
async def create_todo(req: CreateTodoReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await check_list_access(db, req.list_id, user["id"])

        position = await _compute_position(db, req.list_id, req.parent_id, req.after_id)
        cur = await db.execute(
            "INSERT INTO todos (user_id, list_id, content, parent_id, position) VALUES (?, ?, ?, ?, ?)",
            (user["id"], req.list_id, req.content, req.parent_id, position)
        )
        await db.commit()
        async with db.execute(
            "SELECT id, content, checked, parent_id, position FROM todos WHERE id = ?", (cur.lastrowid,)
        ) as c:
            todo = dict(await c.fetchone())
    await manager.broadcast(req.list_id, {"type": "todo_create", "todo": todo})
    return todo


@app.put("/api/todos/{todo_id}")
async def update_todo(todo_id: int, req: UpdateTodoReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, list_id FROM todos WHERE id = ?", (todo_id,)) as cur:
            todo = await cur.fetchone()
        if not todo:
            raise HTTPException(404, "Todo not found")
        list_id = todo["list_id"]
        await check_list_access(db, list_id, user["id"])

        sets = ["updated_at = CURRENT_TIMESTAMP"]
        vals = []
        if req.content is not None:
            sets.append("content = ?")
            vals.append(req.content)
        if req.checked is not None:
            sets.append("checked = ?")
            vals.append(1 if req.checked else 0)

        vals.append(todo_id)
        await db.execute(f"UPDATE todos SET {', '.join(sets)} WHERE id = ?", vals)
        await db.commit()
        async with db.execute(
            "SELECT id, content, checked, parent_id, position FROM todos WHERE id = ?", (todo_id,)
        ) as cur:
            updated = dict(await cur.fetchone())
    await manager.broadcast(list_id, {"type": "todo_update", "todo": updated})
    return updated


@app.put("/api/todos/{todo_id}/move")
async def move_todo(todo_id: int, req: MoveTodoReq, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, list_id FROM todos WHERE id = ?", (todo_id,)) as cur:
            todo = await cur.fetchone()
        if not todo:
            raise HTTPException(404, "Todo not found")
        list_id = todo["list_id"]
        await check_list_access(db, list_id, user["id"])

        if req.parent_id is None:
            await db.execute(
                "UPDATE todos SET parent_id = NULL, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (req.position, todo_id)
            )
        else:
            await db.execute(
                "UPDATE todos SET parent_id = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (req.parent_id, req.position, todo_id)
            )
        await db.commit()
        async with db.execute(
            "SELECT id, content, checked, parent_id, position FROM todos WHERE id = ?", (todo_id,)
        ) as cur:
            moved = dict(await cur.fetchone())
    await manager.broadcast(list_id, {"type": "todo_update", "todo": moved})
    return moved


@app.delete("/api/todos/{todo_id}")
async def delete_todo(todo_id: int, user=Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, list_id FROM todos WHERE id = ?", (todo_id,)) as cur:
            todo = await cur.fetchone()
        if not todo:
            raise HTTPException(404, "Todo not found")
        list_id = todo["list_id"]
        await check_list_access(db, list_id, user["id"])

        async def collect_deleted(tid: int, acc: set):
            acc.add(tid)
            async with db.execute("SELECT id FROM todos WHERE parent_id = ?", (tid,)) as c:
                for row in await c.fetchall():
                    await collect_deleted(row[0], acc)

        deleted_ids: set = set()
        await collect_deleted(todo_id, deleted_ids)

        await _delete_recursive(db, todo_id)
        await db.commit()
    await manager.broadcast(list_id, {"type": "todo_delete", "todoIds": list(deleted_ids)})
    return {"ok": True}


@app.post("/api/todos/bulk-positions")
async def bulk_positions(items: List[BulkPositionItem], user=Depends(get_current_user)):
    list_ids: set = set()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        checked_lists: set = set()
        for item in items:
            async with db.execute("SELECT list_id FROM todos WHERE id = ?", (item.id,)) as cur:
                todo = await cur.fetchone()
            if todo and todo["list_id"] not in checked_lists:
                await check_list_access(db, todo["list_id"], user["id"])
                checked_lists.add(todo["list_id"])
            if todo:
                list_ids.add(todo["list_id"])
                await db.execute(
                    "UPDATE todos SET position = ? WHERE id = ?",
                    (item.position, item.id)
                )
        await db.commit()
    for lid in list_ids:
        await manager.broadcast(lid, {"type": "todo_bulk_move", "items": [i.dict() for i in items]})
    return {"ok": True}


# --- WebSocket presence ---

@app.websocket("/ws/{list_id}")
async def ws_list(list_id: int, websocket: WebSocket, token: Optional[str] = Cookie(default=None)):
    await websocket.accept()
    if not token:
        await websocket.close(1008)
        return
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        await websocket.close(1008)
        return

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)) as cur:
            user = await cur.fetchone()
        if not user:
            await websocket.close(1008)
            return
        try:
            await check_list_access(db, list_id, user_id)
        except HTTPException:
            await websocket.close(1008)
            return

    username = user["username"]
    conn_id = manager.connect(websocket, list_id, user_id, username)
    info = manager.info(conn_id)

    await websocket.send_json({
        "type": "init",
        "connectionId": conn_id,
        "color": info["color"],
        "peers": manager.get_peers(list_id, conn_id),
    })
    await manager.broadcast(list_id, {
        "type": "join",
        "connectionId": conn_id,
        "userId": user_id,
        "username": username,
        "color": info["color"],
    }, exclude=conn_id)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type in ("cursor", "selection", "blur"):
                await manager.broadcast(list_id, {"connectionId": conn_id, **data}, exclude=conn_id)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(conn_id)
        await manager.broadcast(list_id, {"type": "leave", "connectionId": conn_id})


app.mount("/", StaticFiles(directory="static", html=True), name="static")
