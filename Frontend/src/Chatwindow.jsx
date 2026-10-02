import "./Chatwindow.css";
import Chat from "./Chat";
import { MyContext } from "./Mycontext";
import { useContext, useEffect, useRef, useState } from "react";
import { ScaleLoader } from "react-spinners";
import { apiFetch } from "./api";

function Chatwindow() {
    const {
        user,
        setUser,
        prompt,
        setPrompt,
        setNewChat,
        currThreadId,
        setPrevChats,
        setAllThreads,
        setSidebarOpen
    } = useContext(MyContext);

    const [loading, setLoading] = useState(false);
    const [requestError, setRequestError] = useState(null);
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);
    const [activeAccountDialog, setActiveAccountDialog] = useState(null);
    const [sendOnEnter, setSendOnEnter] = useState(() => localStorage.getItem("friendgpt-send-on-enter") !== "false");
    const accountMenuRef = useRef(null);
    const requestInFlight = useRef(false);
    const activeThreadId = useRef(currThreadId);

    useEffect(() => {
        activeThreadId.current = currThreadId;
    }, [currThreadId]);

    useEffect(() => {
        const closeOnOutsideClick = (event) => {
            if (!accountMenuRef.current?.contains(event.target)) {
                setAccountMenuOpen(false);
            }
        };
        const closeOnEscape = (event) => {
            if (event.key === "Escape") {
                setAccountMenuOpen(false);
                setActiveAccountDialog(null);
            }
        };

        document.addEventListener("pointerdown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, []);

    const getReply = async () => {
        if (!prompt.trim() || requestInFlight.current) return;

        const currentPrompt = prompt.trim();
        const requestThreadId = currThreadId;

        requestInFlight.current = true;
        setLoading(true);
        setNewChat(false);
        setRequestError(null);
        setPrevChats((chats) => [...chats, { role: "user", content: currentPrompt }]);

        const options = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                message: currentPrompt,
                threadId: requestThreadId
            })
        };

        let assistantMessageId;
        try {
            const response = await apiFetch("/api/chat", options);
            if (!response.ok) {
                const result = await response.json().catch(() => null);
                throw new Error(result?.error || "Could not send your message");
            }
            if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
                throw new Error("The AI service returned an invalid response");
            }
            if (activeThreadId.current !== requestThreadId) return;

            assistantMessageId = crypto.randomUUID();
            setLoading(false);
            setPrevChats((chats) => [...chats, {
                id: assistantMessageId,
                role: "assistant",
                content: "",
                streaming: true
            }]);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let streamedContent = "";
            let streamFinished = false;

            const consumeEvent = (event) => {
                const lines = event.split("\n");
                const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
                const data = lines
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (!data) return;

                let payload;
                try {
                    payload = JSON.parse(data);
                } catch {
                    throw new Error("The AI service returned an invalid response");
                }

                if (eventName === "error") throw new Error(payload.message || "Could not finish the response");
                if (eventName === "done") {
                    streamFinished = true;
                    return;
                }
                if (typeof payload.token !== "string" || !payload.token) return;

                streamedContent += payload.token;
                setPrevChats((chats) => chats.map((chat) => chat.id === assistantMessageId
                    ? { ...chat, content: chat.content + payload.token }
                    : chat));
            };

            while (true) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                buffer = buffer.replace(/\r\n/g, "\n");
                let boundary = buffer.indexOf("\n\n");
                while (boundary !== -1) {
                    consumeEvent(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf("\n\n");
                }
                if (done) {
                    if (buffer.trim()) consumeEvent(buffer);
                    break;
                }
                if (activeThreadId.current !== requestThreadId) {
                    await reader.cancel();
                    return;
                }
            }

            if (!streamFinished || !streamedContent.trim()) {
                throw new Error("The response was interrupted. Please try again.");
            }
            setPrevChats((chats) => chats.map((chat) => chat.id === assistantMessageId
                ? { ...chat, streaming: false }
                : chat));
            setAllThreads((threads) => {
                const existing = threads.find((thread) => thread.threadId === requestThreadId);
                const title = existing?.title || currentPrompt.replace(/\s+/g, " ").slice(0, 120);
                return [
                    { threadId: requestThreadId, title },
                    ...threads.filter((thread) => thread.threadId !== requestThreadId)
                ];
            });
            setPrompt("");
        } catch (err) {
            if (activeThreadId.current === requestThreadId) {
                setPrevChats((chats) => {
                    const remainingChats = assistantMessageId
                        ? chats.filter((chat) => chat.id !== assistantMessageId)
                        : chats;
                    const lastChat = remainingChats[remainingChats.length - 1];
                    return lastChat?.role === "user" && lastChat.content === currentPrompt
                        ? remainingChats.slice(0, -1)
                        : remainingChats;
                });
                setRequestError({
                    threadId: requestThreadId,
                    message: err.message || "Could not send your message. Please try again."
                });
            }
        } finally {
            requestInFlight.current = false;
            setLoading(false);
        }
    };

    const signOut = async () => {
        try {
            const response = await apiFetch("/api/auth/logout", { method: "POST" });
            if (!response.ok) throw new Error("Could not sign out");
            setPrevChats([]);
            setAllThreads([]);
            setPrompt("");
            setSidebarOpen(false);
            setUser(null);
        } catch (err) {
            console.error(err);
        } finally {
            setAccountMenuOpen(false);
        }
    };

    const openAccountDialog = () => {
        setActiveAccountDialog("settings");
        setAccountMenuOpen(false);
    };

    const updateSendOnEnter = (event) => {
        const isEnabled = event.target.checked;
        setSendOnEnter(isEnabled);
        localStorage.setItem("friendgpt-send-on-enter", String(isEnabled));
    };

    return (
        <div className="chatWindow">

            <div className="navbar">
                <button
                    aria-label="Open conversation history"
                    className="history-toggle"
                    onClick={() => setSidebarOpen(true)}
                    type="button"
                >
                    <i className="fa-solid fa-bars" aria-hidden="true"></i>
                </button>
                <span>
                    SigmaGPT &nbsp;
                    <i className="fa-solid fa-angle-down"></i>
                </span>

                <div className="userIconDiv" ref={accountMenuRef}>
                    <button
                        aria-expanded={accountMenuOpen}
                        aria-haspopup="menu"
                        aria-label="Account menu"
                        className="userIcon"
                        onClick={() => setAccountMenuOpen((open) => !open)}
                        type="button"
                    >
                        {user?.avatarUrl ? (
                            <img src={user.avatarUrl} alt="" />
                        ) : (
                            user?.name?.charAt(0).toUpperCase() || <i className="fa-solid fa-user" aria-hidden="true"></i>
                        )}
                    </button>
                    {accountMenuOpen && (
                        <div className="account-menu" role="menu">
                            <div className="account-menu-user">
                                <strong>{user?.name}</strong>
                                <span>{user?.email}</span>
                            </div>
                            <button onClick={openAccountDialog} role="menuitem" type="button">
                                <i className="fa-solid fa-gear" aria-hidden="true"></i>
                                Settings
                            </button>
                            <button onClick={signOut} role="menuitem" type="button">
                                <i className="fa-solid fa-arrow-right-from-bracket" aria-hidden="true"></i>
                                Sign out
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {activeAccountDialog && (
                <div
                    className="account-dialog-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) setActiveAccountDialog(null);
                    }}
                >
                    <section
                        aria-labelledby="account-dialog-title"
                        aria-modal="true"
                        className="account-dialog"
                        role="dialog"
                    >
                        <header className="account-dialog-header">
                            <div>
                                <p>PREFERENCES</p>
                                <h2 id="account-dialog-title">Settings</h2>
                            </div>
                            <button
                                aria-label="Close dialog"
                                className="account-dialog-close"
                                onClick={() => setActiveAccountDialog(null)}
                                type="button"
                            >
                                <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </header>

                        <div className="account-dialog-content">
                            <div className="settings-account">
                                <span className="settings-avatar">
                                    {user?.name?.charAt(0).toUpperCase() || "U"}
                                </span>
                                <div>
                                    <strong>{user?.name}</strong>
                                    <span>{user?.email}</span>
                                </div>
                            </div>
                            <label className="settings-toggle">
                                <span>
                                    <strong>Send with Enter</strong>
                                    <small>Turn this off to prevent Enter from sending messages.</small>
                                </span>
                                <input checked={sendOnEnter} onChange={updateSendOnEnter} type="checkbox" />
                            </label>
                        </div>
                    </section>
                </div>
            )}

            <Chat />

            <ScaleLoader
                color="#fff"
                loading={loading}
            />

            <div className="chatInput">
                {requestError?.threadId === currThreadId && (
                    <p className="chat-error" role="alert">{requestError.message}</p>
                )}

                <form className="inputBox" onSubmit={(event) => { event.preventDefault(); getReply(); }}>

                    <textarea
                        aria-label="Message"
                        maxLength={8000}
                        minLength={1}
                        placeholder="Ask Anything"
                        rows={1}
                        value={prompt}
                        disabled={loading}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && sendOnEnter && !e.shiftKey) {
                                e.preventDefault();
                                getReply();
                            }
                        }}
                    />

                    <button
                        aria-label="Send message"
                        disabled={loading || !prompt.trim()}
                        id="submit"
                        type="submit"
                    >
                        <i
                            className="fa-solid fa-paper-plane"
                            aria-hidden="true"
                        ></i>
                    </button>

                </form>

                <p className="info">
                    SigmaGPT can make mistakes. Verify important information.
                </p>

            </div>

        </div>
    );
}

export default Chatwindow;