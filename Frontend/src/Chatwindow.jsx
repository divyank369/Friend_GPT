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
        setReply,
        setNewChat,
        currThreadId,
        setPrevChats,
        setAllThreads
    } = useContext(MyContext);

    const [loading, setLoading] = useState(false);
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);
    const [activeAccountDialog, setActiveAccountDialog] = useState(null);
    const [sendOnEnter, setSendOnEnter] = useState(() => localStorage.getItem("friendgpt-send-on-enter") !== "false");
    const accountMenuRef = useRef(null);

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
        if (!prompt.trim() || loading) return;

        const currentPrompt = prompt;

        setLoading(true);
        setNewChat(false);

        console.log(
            "message",
            currentPrompt,
            "threadId",
            currThreadId
        );

        const options = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                message: currentPrompt,
                threadId: currThreadId
            })
        };

        try {
            const response = await apiFetch("/api/chat", options);

            const res = await response.json();

            console.log(res);

            const assistantReply = res.reply;

            // Add user message and AI response only once
            setPrevChats((prevChats) => [
                ...prevChats,
                {
                    role: "user",
                    content: currentPrompt
                },
                {
                    role: "assistant",
                    content: assistantReply
                }
            ]);

            setReply(assistantReply);

            // Clear input
            setPrompt("");

        } catch (err) {
            console.log(err);
        } finally {
            setLoading(false);
        }
    };

    const signOut = async () => {
        try {
            const response = await apiFetch("/api/auth/logout", { method: "POST" });
            if (!response.ok) throw new Error("Could not sign out");
            setPrevChats([]);
            setAllThreads([]);
            setReply(null);
            setPrompt("");
            setUser(null);
        } catch (err) {
            console.error(err);
        } finally {
            setAccountMenuOpen(false);
        }
    };

    const openAccountDialog = (dialog) => {
        setActiveAccountDialog(dialog);
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
                <span>
                    FriendGpt &nbsp;
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
                            <button onClick={() => openAccountDialog("settings")} role="menuitem" type="button">
                                <i className="fa-solid fa-gear" aria-hidden="true"></i>
                                Settings
                            </button>
                            <button onClick={() => openAccountDialog("upgrade")} role="menuitem" type="button">
                                <i className="fa-solid fa-arrow-up-right-dots" aria-hidden="true"></i>
                                Upgrade plan
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
                                <p>{activeAccountDialog === "settings" ? "PREFERENCES" : "SUBSCRIPTION"}</p>
                                <h2 id="account-dialog-title">
                                    {activeAccountDialog === "settings" ? "Settings" : "Upgrade your plan"}
                                </h2>
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

                        {activeAccountDialog === "settings" ? (
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
                        ) : (
                            <div className="account-dialog-content">
                                <div className="plan-option">
                                    <div>
                                        <p>FRIENDGPT</p>
                                        <h3>Free</h3>
                                    </div>
                                    <span className="current-plan">CURRENT PLAN</span>
                                </div>
                                <p className="billing-notice">
                                    Paid plans and checkout aren’t connected yet. Your current conversations remain available on the free plan.
                                </p>
                                <button className="plan-upgrade-button" disabled type="button">
                                    Billing setup required
                                </button>
                            </div>
                        )}
                    </section>
                </div>
            )}

            <Chat />

            <ScaleLoader
                color="#fff"
                loading={loading}
            />

            <div className="chatInput">

                <div className="inputBox">

                    <input
                        placeholder="Ask Anything"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && sendOnEnter) {
                                getReply();
                            }
                        }}
                    />

                    <div
                        id="submit"
                        onClick={getReply}
                    >
                        <i
                            className="fa-solid fa-paper-plane"
                            aria-hidden="true"
                        ></i>
                    </div>

                </div>

                <p className="info">
                    FriendGpt can make mistake.
                    Check important info. See Cookie Preferences.
                </p>

            </div>

        </div>
    );
}

export default Chatwindow;