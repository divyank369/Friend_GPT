# SigmaGPT

SigmaGPT is a React/Vite chat client and Express API backed by MongoDB. The API verifies email/password sessions and Google ID tokens; chat history is stored per authenticated user.

## Local setup

Create `Backend/.env` with these values:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/sigmagpt
GROQ_API_KEY=your-groq-api-key
AUTH_JWT_SECRET=generate-a-long-random-secret
GOOGLE_CLIENT_ID=your-google-web-client-id
FRONTEND_ORIGIN=http://localhost:5173
```

Create `Frontend/.env`:

```dotenv
VITE_API_URL=http://localhost:8080
VITE_GOOGLE_CLIENT_ID=your-google-web-client-id
```

Generate a session secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. The Google client ID is public; never place a Google client secret or AI key in the frontend. Add `http://localhost:5173` as an authorized JavaScript origin in Google Cloud Console.

Run the backend and frontend in separate terminals:

```sh
cd Backend && npm install && npm run dev
```

```sh
cd Frontend && npm install && npm run dev
```

New accounts receive private thread history. Older pre-authentication threads are not assigned to accounts automatically.

## Render deployment

The current checkout has no `render.yaml`, so create two Render services manually:

| Service | Root directory | Build command | Start/publish |
| --- | --- | --- | --- |
| API Web Service | `Backend` | `npm ci` | `npm start` |
| Static Site | `Frontend` | `npm ci && npm run build` | Publish `dist` |

Set the API health check path to `/health`. Configure these API environment variables: `NODE_ENV=production`, `MONGODB_URI` (a reachable MongoDB Atlas URI), `GROQ_API_KEY`, `AUTH_JWT_SECRET` (a strong random value), `FRONTEND_ORIGIN` (the exact static-site origin, including `https://` and no trailing slash), and `GOOGLE_CLIENT_ID` if Google sign-in is enabled. Optional API settings are `GROQ_MODEL`, `GROQ_API_URL`, and `SESSION_COOKIE_SAME_SITE=lax` when the services share a site. Set `VITE_API_URL` to the API's public Render URL and `VITE_GOOGLE_CLIENT_ID` to the same Google client ID when building the static site.

For separate Render hostnames, the session cookie defaults to `SameSite=None; Secure`. `SESSION_COOKIE_SAME_SITE` can be set to `lax` when the frontend and API share a site. Add the production static-site origin to the Google OAuth client's authorized JavaScript origins; this credential-based flow does not use a redirect URI. Redeploy the frontend after changing any `VITE_` values because Vite embeds them at build time.

The current checkout also lacks the `.env.example` templates; create local env files using the variable lists above. Neither env file should be committed.

The earlier committed Render Blueprint selected Render's free plan. If you restore or recreate that Blueprint, review Render's current free-instance limits before provisioning.
