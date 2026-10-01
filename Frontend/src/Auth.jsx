import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { apiFetch } from "./api";
import "./Auth.css";

function Auth({ onAuthenticated, googleEnabled }) {
    const [mode, setMode] = useState("login");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const completeGoogleSignIn = async (credentialResponse) => {
        if (!credentialResponse.credential) {
            setError("Google sign-in did not return a credential. Please try again.");
            return;
        }

        setError("");
        setSubmitting(true);
        try {
            const response = await apiFetch("/api/auth/google", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken: credentialResponse.credential })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || "Google sign-in failed");
            }
            onAuthenticated(result.user);
        } catch (err) {
            setError(err.message || "Google sign-in failed");
        } finally {
            setSubmitting(false);
        }
    };

    const submitCredentials = async (event) => {
        event.preventDefault();
        setError("");
        setSubmitting(true);

        try {
            const response = await apiFetch(`/api/auth/${mode === "signup" ? "signup" : "login"}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, password })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || "Authentication failed");
            }
            onAuthenticated(result.user);
        } catch (err) {
            setError(err.message || "Authentication failed");
        } finally {
            setSubmitting(false);
        }
    };

    const isSignup = mode === "signup";

    return (
        <main className="auth-screen">
            <section className="auth-panel" aria-labelledby="auth-title">
                <div className="auth-brand-mark" aria-hidden="true">
                    <i className="fa-solid fa-comment-dots"></i>
                </div>
                <p className="auth-eyebrow">FriendGPT</p>
                <h1 id="auth-title">{isSignup ? "Create your account" : "Welcome back"}</h1>
                <p className="auth-intro">
                    {isSignup ? "Your conversations, kept in one place." : "Sign in to continue your conversations."}
                </p>

                <form className="auth-form" onSubmit={submitCredentials}>
                    {isSignup && (
                        <label>
                            Name
                            <input
                                autoComplete="name"
                                maxLength={80}
                                onChange={(event) => setName(event.target.value)}
                                required
                                value={name}
                            />
                        </label>
                    )}
                    <label>
                        Email
                        <input
                            autoComplete="email"
                            onChange={(event) => setEmail(event.target.value)}
                            required
                            type="email"
                            value={email}
                        />
                    </label>
                    <label>
                        Password
                        <input
                            autoComplete={isSignup ? "new-password" : "current-password"}
                            minLength={isSignup ? 8 : undefined}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                            type="password"
                            value={password}
                        />
                    </label>
                    {error && <p className="auth-error" role="alert">{error}</p>}
                    <button className="auth-submit" disabled={submitting} type="submit">
                        {submitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
                    </button>
                </form>

                <div className="auth-divider"><span>or continue with</span></div>
                <div className="google-signin">
                    {googleEnabled ? (
                        <GoogleLogin
                            onError={() => setError("Google sign-in failed. Please try again.")}
                            onSuccess={completeGoogleSignIn}
                            width="320"
                        />
                    ) : (
                        <p>Google sign-in is unavailable until its client ID is configured.</p>
                    )}
                </div>

                <p className="auth-switch">
                    {isSignup ? "Already have an account?" : "New to FriendGPT?"}
                    <button
                        onClick={() => {
                            setMode(isSignup ? "login" : "signup");
                            setError("");
                        }}
                        type="button"
                    >
                        {isSignup ? "Sign in" : "Create an account"}
                    </button>
                </p>
            </section>
        </main>
    );
}

export default Auth;