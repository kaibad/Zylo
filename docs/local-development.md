# ZYLO Local Development & Architecture Guide

Welcome to the comprehensive guide for setting up, running, and understanding the architecture of **ZYLO**.

---

## Prerequisites
- **Node.js 20+**
- **Docker Desktop** (Recommended for Database) OR **PostgreSQL 16+**

---

## Setup & Running the Application

### 1. Database Setup (Using Docker)
The easiest way to get the PostgreSQL database running with the correct credentials is to use the provided Docker configuration.

In the root of the project, run:
```bash
docker compose up -d
```
*This spins up a PostgreSQL 16 instance on port `5432` using the credentials defined in `docker-compose.yml`.*

#### Inspecting the Database
To connect to the running PostgreSQL container and query your database directly, use `docker exec` and the `psql` utility:

```bash
docker exec -it zylo-postgres psql -U zylo_user -d zylo_db
```

Common verification commands inside `psql`:
- List tables: `\dt`
- View all posts: `SELECT * FROM posts;`
- View registered users: `SELECT * FROM users;`
- Exit psql: `\q`

### 2. Backend API
Navigate to the `backend` directory and install dependencies:
```bash
cd backend
npm install
```

Create a `.env` file inside the `backend` directory:
```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=zylo_user
DB_PASSWORD=zylo_pass_2026
DB_NAME=zylo_db
PORT=5000
JWT_SECRET=zylo-jwt-secret-2026-change-me-in-production
```

> **Note:** Change `JWT_SECRET` to a long random string in any production or staging environment.

Start the backend server:
```bash
npm start
```
*The backend API will run on `http://localhost:5000`.*

### 3. Frontend Application
Open a new terminal, navigate to the `frontend` directory, and install dependencies:
```bash
cd frontend
npm install
```

Start the Vite development server:
```bash
npm run dev
```
*The frontend application will be accessible at `http://localhost:3000`.*

---

## API Endpoints

### Health
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | Health check |

### Authentication
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | None | Register a new user |
| POST | `/api/auth/login` | None | Log in and receive a JWT |
| GET | `/api/auth/me` | Required | Get current authenticated user |

### Posts
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/posts` | Optional | Get all visible posts (public + owner's private) |
| GET | `/api/posts/:id` | Optional | Get single post with comments (blocked if private + not owner) |
| POST | `/api/posts` | Required | Create a new post |
| PUT | `/api/posts/:id` | Required (owner) | Update a post |
| DELETE | `/api/posts/:id` | Required (owner) | Delete a post |

### Comments
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/comments/post/:postId` | None | Get all comments for a post |
| POST | `/api/comments` | None | Add a comment |
| DELETE | `/api/comments/:id` | None | Delete a comment |

---

## Authentication & Post Visibility Architecture

ZYLO uses a stateless JWT-based authentication system. Users register with a username and password, receive a signed token, and use that token to access protected API routes.

### How It Works

#### Registration & Login
1. A user visits `/register` and submits a username and password.
2. The backend hashes the password using **bcrypt** (12 salt rounds) and stores the user in the `users` table.
3. A **JSON Web Token (JWT)** is signed with the server's `JWT_SECRET` and returned to the client.
4. The frontend stores the token and user object in `localStorage`.
5. Login (`/login`) performs the same flow — it verifies the password hash and returns a fresh JWT.

#### Token Usage
The frontend's `AuthContext` registers an **Axios request interceptor** that automatically attaches the token to every outgoing request:
```
Authorization: Bearer <token>
```
This means the token is injected globally on the client side as long as the user is logged in.

#### Token Expiry
Tokens are valid for **30 days**. The backend returns a `401 Unauthorized` response for expired or invalid tokens.

### Database Schema

```sql
-- Users Table
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Posts Table (Modified Columns)
ALTER TABLE posts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT false;
```

### Post Visibility Rules

| Post Type | Who Can See It in the Feed | Who Can Open It Directly |
|-----------|---------------------------|--------------------------|
| Public | Everyone (logged in or not) | Everyone |
| Private | Owner only (when logged in) | Owner only |
| Legacy (no `user_id`) | Everyone (treated as public) | Everyone |

#### Backend Enforcement
- **`GET /api/posts`** uses `optionalAuth` middleware: If a valid JWT is present, it returns all public posts **plus** the authenticated user's own private posts. If no token, it returns only public posts.
- **`GET /api/posts/:id`** uses `optionalAuth`: If the post is private and the requester is not the owner, it returns `403 Forbidden`.
- **`POST`, `PUT`, `DELETE /api/posts`** use `authenticate` middleware: Requires a valid JWT. `PUT` and `DELETE` check that `post.user_id === req.user.id`, returning `403` on mismatch.

### Frontend Auth Flow

The context provides the following values to the entire app via `useAuth()`:
- `user`: Current logged-in user `{ id, username }` (or `null`)
- `token`: The raw JWT string (or `null`)
- `loading`: `true` while restoring session from `localStorage`
- `login(username, password)`: Calls `/api/auth/login`, stores credentials
- `register(username, password)`: Calls `/api/auth/register`, stores credentials
- `logout()`: Clears token and user from `localStorage`

### UI Behavior
- **Navbar**: Signed-out users see **Sign In** and **Register**. Signed-in users see their username, a **New Post** button, and a **Logout** button.
- **Feed**: Private posts display with a **Private** lock badge, visible only to the owner.
- **Post Detail**: **Edit** and **Delete** buttons are only rendered if the logged-in user is the owner. Direct navigation to a private post by another user displays a "This post is private" state.
- **Create / Edit Post**: Features a visibility toggle to select **Public** or **Private**. Accessing `/create` while logged out displays an authentication prompt.

### Security Notes
- **Password Storage**: bcrypt with 12 salt rounds.
- **Token Signing**: HS256 JWT signed with `JWT_SECRET`.
- **Ownership Checks**: Server-side comparison of `post.user_id` and `req.user.id` on all mutating endpoints.
