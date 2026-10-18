# SigmaGPT — Friend_GPT

A full-stack AI chat application with a React interface, an Express API, and MongoDB-backed conversations. It streams assistant responses to the browser and includes private knowledge sources, file-aware chat, image generation, and an optional website builder.

## Highlights

- Email/password and Google sign-in
- Private conversation history and text knowledge sources
- Streaming chat responses with Markdown and code highlighting
- Image and PDF attachments, image-aware chat, and resume text extraction
- User-owned generated image library
- Optional web search and code execution for supported text models
- Website preview, repair, and deployment workflows
- Responsive React and Vite frontend

## Architecture

| App | Role |
| --- | --- |
| `Backend/` | Express API, authentication, AI workflow, uploads, and deployment services |
| `Frontend/` | React and Vite chat and website-builder interface |
| `SandboxRunner/` | Isolated runner used by website-building workflows |
| `render.yaml` | Render service blueprint |

## Technology

React 19 · Vite · Node.js 22.12+ · Express 5 · MongoDB · LangGraph · Groq · OpenAI image generation API

## Get Started

### Requirements

- Node.js 22.12 or later and npm
- MongoDB, local or hosted
- Groq API key
- Google OAuth web client ID if Google sign-in is needed
- OpenAI API key if image generation is needed

### Configure environment

Copy the example environment files:

```powershell
Copy-Item Backend/.env.example Backend/.env
Copy-Item Frontend/.env.example Frontend/.env
```

Set the backend values in `Backend/.env`:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `GROQ_API_KEY` | Server-side key for chat generation |
| `AUTH_JWT_SECRET` | Secret used to sign session tokens |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID, when Google sign-in is enabled |
| `FRONTEND_ORIGIN` | Allowed frontend origin or origins in production |
| `OPENAI_API_KEY` | Required for image generation |

Set `VITE_GOOGLE_CLIENT_ID` in `Frontend/.env` to enable Google sign-in in the browser. The frontend API URL defaults to `http://localhost:8080` in development. Keep provider secrets on the backend; never put them in frontend variables.

### Run the apps

In one terminal:

```powershell
cd Backend
npm install
npm run dev
```

In a second terminal:

```powershell
cd Frontend
npm install
npm run dev
```

The API uses port `8080` by default. Vite prints the frontend URL, normally `http://localhost:5173`.

## Development Checks

```powershell
cd Backend
npm test
```

```powershell
cd Frontend
npm run lint
npm run build
```

## Notes

The app stores user conversations, knowledge sources, uploads, and generated images in MongoDB. Live search and code execution are available only through supported Groq text models. Uploaded images use the configured vision model; PDF parsing extracts selectable text. Review `SANDBOX_DEPLOYMENT.md` before enabling website sandbox or deployment features.

See `render.yaml` for the production service layout and `Backend/.env.example` for the current environment configuration.
