# SigmaGPT

SigmaGPT is a full-stack AI chat application with a React interface, an Express API, and MongoDB-backed conversation history. Assistant responses stream to the browser as they are generated, while each completed exchange is stored in the conversation thread.

## Features

- Email and password registration and sign-in, plus Google sign-in
- Private conversation history associated with the authenticated user
- Progressive assistant responses over Server-Sent Events (SSE)
- Markdown rendering with GitHub Flavored Markdown and highlighted code blocks
- Thread creation, history listing, loading, and deletion
- Responsive React/Vite frontend and Express API
- Render Blueprint configuration for deployment

## Technology Stack

| Area | Technologies |
| --- | --- |
| Frontend | React 19, Vite, React Markdown, remark-gfm, rehype-highlight |
| Backend | Node.js 22+, Express 5, Mongoose |
| Database | MongoDB |
| AI | Groq API using its OpenAI-compatible Chat Completions streaming interface |
| Authentication | JWT, HTTP-only cookies, bcryptjs, Google ID token verification |
| Supporting tools | Vite, UUID, express-rate-limit, CORS, cookie-parser |

## How It Works

1. The React app checks the current session with `GET /api/auth/me` and sends API requests with cookies included.
2. The user submits a message to `POST /api/chat` with a conversation ID. The backend authenticates the session and retrieves or initializes that user's thread.
3. The backend sends the recent conversation context and SigmaGPT system instruction to the configured Groq model with streaming enabled.
4. Each provider token is forwarded to the browser as an SSE event. The UI appends tokens to a single assistant message as they arrive.
5. Once generation completes, the backend saves the user message and the full assistant response to MongoDB as one exchange, then sends a completion event.

If the client disconnects, the active provider request is aborted. Incomplete provider streams are treated as errors and are not saved as completed responses.

## Project Structure

```text
.
├── Backend/
│   ├── middleware/       # Session authentication
│   ├── models/           # Mongoose User and Thread schemas
│   ├── routes/           # Authentication and chat/thread API routes
│   ├── tests/            # Backend tests
│   ├── utils/            # AI provider integration and streaming parser
│   └── server.js         # Express setup and application startup
├── Frontend/
│   ├── public/           # Static frontend assets
│   └── src/              # React app, chat UI, context, and API client
└── render.yaml           # Render API and static-site Blueprint
```

## Getting Started

### Prerequisites

- Node.js 22.12 or later and npm
- A MongoDB instance (local or hosted)
- A Groq API key
- A Google OAuth web client ID if Google sign-in is needed

### Configure Environment

From the repository root, copy the example files:

```powershell
Copy-Item Backend/.env.example Backend/.env
Copy-Item Frontend/.env.example Frontend/.env
```

Set these backend variables in `Backend/.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `GROQ_API_KEY` | Yes | Server-side API key used for AI requests |
| `AUTH_JWT_SECRET` | Yes | Secret used to sign session tokens; use a long random value |
| `GOOGLE_CLIENT_ID` | For Google sign-in | Google OAuth web client ID; the server verifies Google ID tokens against it |
| `FRONTEND_ORIGIN` | Production | Allowed frontend origin; local development defaults to `http://localhost:5173` |
| `GROQ_MODEL` | No | Model override; defaults to `openai/gpt-oss-20b` |
| `GROQ_API_URL` | No | OpenAI-compatible API URL override |

Set these frontend variables in `Frontend/.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_API_URL` | No | API base URL; defaults to `http://localhost:8080` in development |
| `VITE_GOOGLE_CLIENT_ID` | For Google sign-in | The same public Google OAuth web client ID used by the backend |

Never put `GROQ_API_KEY` or other server secrets in frontend environment variables. To enable Google sign-in locally, add `http://localhost:5173` as an authorized JavaScript origin in the Google OAuth client configuration.

### Install and Run

Start the backend in one terminal:

```powershell
cd Backend
npm install
npm run dev
```

Start the frontend in another terminal:

```powershell
cd Frontend
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`. The API listens on port `8080` by default.

## Authentication and Data

- Passwords are hashed with bcryptjs; the password hash is excluded from normal user queries.
- Successful sign-in sets a signed JWT in the `friendgpt_session` HTTP-only cookie. Sessions expire after seven days.
- Google credentials are verified server-side using the Google ID token and configured client ID.
- Chat and thread endpoints require an authenticated session. Thread lookups and writes are scoped to the session user's ID.
- The API rate-limits requests globally, with stricter limits for authentication and chat generation.
- A thread contains its owner, thread ID, title, and ordered messages. Messages use `user` or `assistant` roles with content and timestamps.
- The completed user/assistant exchange is persisted once generation succeeds; individual streamed tokens are not separate database messages.

## API Reference

All routes are served from the backend origin. Most API errors use an `error` field; a missing thread currently returns a JSON string with status `404`. Authentication routes are under `/api/auth`; chat and thread routes are under `/api`.

| Method | Endpoint | Authentication | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | No | Create an account with `name`, `email`, and `password` |
| `POST` | `/api/auth/login` | No | Sign in with `email` and `password` |
| `POST` | `/api/auth/google` | No | Sign in with a Google `idToken` |
| `GET` | `/api/auth/me` | Yes | Return the current user |
| `POST` | `/api/auth/logout` | No | Clear the session cookie |
| `POST` | `/api/chat` | Yes | Send a message and receive an SSE response stream |
| `GET` | `/api/thread` | Yes | List the current user's threads |
| `GET` | `/api/thread/:threadId` | Yes | Load one thread's messages |
| `DELETE` | `/api/thread/:threadId` | Yes | Delete one of the current user's threads |
| `GET` | `/health` | No | Report API and database health |

### Chat Request and Stream

Send JSON to `POST /api/chat`:

```json
{
  "threadId": "conversation-id",
  "message": "Explain React hooks"
}
```

Successful responses use `Content-Type: text/event-stream`. Token events contain one token each:

```text
data: {"token":"React hooks"}

```

The stream ends with a `done` event. If an error occurs after streaming has started, the server sends an `error` event; errors before streaming begins are returned as JSON with an appropriate HTTP status. Messages are limited to 8,000 characters, and the model context is bounded to recent conversation history.

## Development Checks

Run backend tests:

```powershell
cd Backend
npm test
```

Lint and build the frontend:

```powershell
cd Frontend
npm run lint
npm run build
```

## Deployment

The root `render.yaml` defines an Express API service and a static Vite frontend. The API uses `/health` as its health check; the frontend rewrites application routes to `index.html`. Configure the production MongoDB URI, Groq key, Google client ID, frontend origin, and session secret in Render. The Blueprint generates `AUTH_JWT_SECRET` and connects the frontend's `VITE_API_URL` to the API service.
