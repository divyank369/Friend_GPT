import "./Sidebar.css";
import mylogo from "./assets/mylogo.png";
import { useContext, useEffect, useRef, useState } from "react";
import { MyContext } from "./Mycontext";
import { v1 as uuidv1 } from "uuid";
import { apiFetch } from "./api";
function Sidebar() {

    const {
        allThreads,
        setAllThreads,
        currThreadId,
        setCurrThreadId,
        setNewChat,
        setPrompt,
        setPrevChats,
        sidebarOpen,
        setSidebarOpen
    } = useContext(MyContext);
    const [historyError, setHistoryError] = useState("");
    const [historyLoading, setHistoryLoading] = useState(true);
    const selectedThreadId = useRef(currThreadId);

    const createNewChat = () => {
        const threadId = uuidv1();
        selectedThreadId.current = threadId;
        setCurrThreadId(threadId);
        setNewChat(true);
        setPrompt("");
        setPrevChats([]);
        setHistoryError("");
        setSidebarOpen(false);
    };
    const changeThread = async (newThreadId) => {
        selectedThreadId.current = newThreadId;
        setCurrThreadId(newThreadId);
        setSidebarOpen(false);
        setHistoryError("");
        setPrevChats([]);
        setNewChat(true);
        try{
            const response = await apiFetch(`/api/thread/${newThreadId}`);
            if (!response.ok) {
                const result = await response.json().catch(() => null);
                throw new Error(result?.error || "Could not open this conversation");
            }
            const res = await response.json();
            if (selectedThreadId.current !== newThreadId) return;
            setPrevChats(res);
            setNewChat(false);
        }
        catch(err){
            if (selectedThreadId.current === newThreadId) setHistoryError(err.message || "Could not open this conversation");
        }
       
    };

    const deleteThread = async (event, threadId) => {
        event.stopPropagation();

        try {
            const response = await apiFetch(`/api/thread/${threadId}`, {
                method: "DELETE"
            });
            if (!response.ok) {
                const result = await response.json().catch(() => null);
                throw new Error(result?.error || "Could not delete this conversation");
            }

            setAllThreads((threads) => threads.filter((thread) => thread.threadId !== threadId));
            if (currThreadId === threadId) {
                createNewChat();
            }
        } catch (err) {
            setHistoryError(err.message || "Could not delete this conversation");
        }
    };

    useEffect(() => {
        const controller = new AbortController();
        const getAllThreads = async () => {
            try {
                const response = await apiFetch("/api/thread", { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`Failed to fetch threads: ${response.status}`);
                }
                const res = await response.json();
                setAllThreads(res.map((thread) => ({ threadId: thread.threadId, title: thread.title })));
            } catch (err) {
                if (!controller.signal.aborted) {
                    setHistoryError(err.message || "Could not load conversation history");
                }
            } finally {
                if (!controller.signal.aborted) setHistoryLoading(false);
            }
        };

        getAllThreads();
        return () => controller.abort();
    }, [setAllThreads]);
    return (
        <aside aria-label="Conversation history" className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}>
            <div className="sidebar-header">
                <button aria-label="Start a new chat" onClick={createNewChat} className="newchat" type="button">
                    <img src={mylogo} alt="" className="logo" />
                    <span><i className="fa-solid fa-pen-to-square" aria-hidden="true"></i></span>
                </button>
                <button
                    aria-label="Close conversation history"
                    className="sidebar-close"
                    onClick={() => setSidebarOpen(false)}
                    type="button"
                >
                    <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>

            <ul className="history">
                {historyError && <li className="history-message" role="alert">{historyError}</li>}
                {!historyError && historyLoading && <li className="history-message">Loading conversations…</li>}
                {!historyError && !historyLoading && allThreads.length === 0 && (
                    <li className="history-message">No conversations yet</li>
                )}
                {
                    allThreads?.map((thread) => (
                        <li key={thread.threadId} className={currThreadId === thread.threadId ? "active" : ""}>
                            <button
                                aria-current={currThreadId === thread.threadId ? "page" : undefined}
                                className="thread-select"
                                onClick={() => changeThread(thread.threadId)}
                                type="button"
                            >
                                <span className="thread-title">{thread.title || "Untitled conversation"}</span>
                            </button>
                            <button
                                type="button"
                                className="delete-thread"
                                aria-label={`Delete ${thread.title || "conversation"}`}
                                title="Delete thread"
                                onClick={(event) => deleteThread(event, thread.threadId)}
                            >
                                <i className="fa-solid fa-trash-can" aria-hidden="true"></i>
                            </button>
                        </li>
                    ))
                }
            </ul>

            <div className="sign">
                <p>Your chat history</p>
            </div>
        </aside>
    );
}

export default Sidebar;