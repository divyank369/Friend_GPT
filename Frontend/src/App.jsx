import Sidebar from "./Sidebar";
import "./App.css";
import Chatwindow from "./Chatwindow";
import { MyContext } from "./Mycontext";
import { useEffect, useState } from "react";
import { v1 as uuidv1 } from "uuid";
import { GoogleOAuthProvider } from "@react-oauth/google";
import Auth from "./Auth";
import { apiFetch } from "./api";

function App() {
    const [user, setUser] = useState(null);
    const [checkingSession, setCheckingSession] = useState(true);
    const [prompt, setPrompt] = useState("");
    const [reply, setReply] = useState(null);
    const [currThreadId, setCurrThreadId] = useState(uuidv1());
    const [prevChats, setPrevChats] = useState([]);
    const [newChat, setNewChat] = useState(true);
    const[allThreads, setAllThreads] = useState([]);
    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

    useEffect(() => {
        let isMounted = true;
        apiFetch("/api/auth/me")
            .then(async (response) => response.ok ? response.json() : null)
            .then((result) => {
                if (isMounted && result?.user) setUser(result.user);
            })
            .catch(() => {})
            .finally(() => {
                if (isMounted) setCheckingSession(false);
            });

        return () => {
            isMounted = false;
        };
    }, []);

    const providerValue = {
        user,
        setUser,
        prompt,
        setPrompt,
        reply,
        setReply,
        currThreadId,
        setCurrThreadId,
        newChat,
        setNewChat,
        prevChats,
        setPrevChats,
        allThreads,
        setAllThreads
    };

    let content;
    if (checkingSession) {
        content = <main className="auth-loading">Checking your session…</main>;
    } else if (!user) {
        content = <Auth googleEnabled={Boolean(googleClientId)} onAuthenticated={setUser} />;
    } else {
        content = (
            <div className="app">
                <MyContext.Provider value={providerValue}>
                    <Sidebar />
                    <Chatwindow />
                </MyContext.Provider>
            </div>
        );
    }

    return googleClientId ? (
        <GoogleOAuthProvider clientId={googleClientId}>{content}</GoogleOAuthProvider>
    ) : content;
}

export default App;