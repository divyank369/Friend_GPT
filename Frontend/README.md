# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Authentication setup

Copy `Backend/.env.example` to `Backend/.env` and `Frontend/.env.example` to `Frontend/.env`. Set `MONGODB_URI`, `GROQ_API_KEY`, and a strong random `AUTH_JWT_SECRET` in the backend file. Generate a secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For Google sign-in, create a Web OAuth client in Google Cloud Console and add `http://localhost:5173` as an authorized JavaScript origin. Put the same client ID in `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`. The client ID is public; do not put a Google client secret in the frontend.

Start the backend from `Backend` with `npm run dev`, then start Vite from `Frontend` with `npm run dev`. New accounts receive their own private thread history; older threads created before authentication are not assigned to an account automatically.

## Deploying to Render

The repository root contains `render.yaml` for the API web service and frontend static site. Push the repository to GitHub, create a new Blueprint in Render, and select that repository. Provide `MONGODB_URI`, `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, and `FRONTEND_ORIGIN` when prompted. Use MongoDB Atlas or another reachable MongoDB instance; Render does not provide MongoDB. Set `FRONTEND_ORIGIN` to the deployed static site's exact `https://...onrender.com` URL. Use the same Google OAuth client ID for both prompts, and add the deployed frontend URL as an authorized JavaScript origin in Google Cloud Console.

The Blueprint generates `AUTH_JWT_SECRET` and wires the API URL into the frontend build. If Render assigns a different service URL than expected, update `FRONTEND_ORIGIN` in the API service and redeploy it.
