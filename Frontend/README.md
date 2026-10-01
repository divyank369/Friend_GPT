# SigmaGPT

SigmaGPT is a React/Vite chat client and Express API backed by MongoDB. The API verifies email/password sessions and Google ID tokens; chat history is stored per authenticated user.

## Local setup

Copy the example files to local environment files, then set real development values:

```powershell
Copy-Item Backend/.env.example Backend/.env
Copy-Item Frontend/.env.example Frontend/.env
```

Set `MONGODB_URI`, `GROQ_API_KEY`, and a strong `AUTH_JWT_SECRET` in `Backend/.env`. Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. The Google client ID is public; never place a Google client secret or AI key in the frontend. Add `http://localhost:5173` as an authorized JavaScript origin in Google Cloud Console, and set the same client ID in both env files.

Run the backend and frontend in separate terminals:

```sh
cd Backend && npm install && npm run dev
```

```sh
cd Frontend && npm install && npm run dev
```

New accounts receive private thread history. Older pre-authentication threads are not assigned to accounts automatically.

## Render deployment

The repository root contains `render.yaml`, which configures an API web service and a static frontend. Push it to GitHub, then in Render choose **New + > Blueprint**, connect this repository, and select the `main` branch. The Blueprint uses Node 22, deploys the API on Render's free plan, adds the `/health` check, and rewrites frontend routes to `index.html`.

During Blueprint setup, provide `MONGODB_URI` for a reachable MongoDB Atlas database, `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, and `FRONTEND_ORIGIN`. Use the expected static URL `https://sigmagpt-web.onrender.com`; if Render assigns a different URL, update `FRONTEND_ORIGIN` on the API service and redeploy. Render generates `AUTH_JWT_SECRET`, and the frontend API URL is wired from the API service automatically. Enter the same Google client ID for `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`.

After the services are created, add the actual frontend `https://...onrender.com` URL to the Google OAuth client's authorized JavaScript origins. This credential-based flow does not use a redirect URI. Session cookies use `SameSite=None; Secure` for separate Render hostnames. Check Render's current free-plan limits before provisioning; free services can sleep when idle. Changes to `VITE_` variables require a frontend rebuild.
