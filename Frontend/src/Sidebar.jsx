import "./Sidebar.css";
import blacklogo from "./assets/blacklogo.png";
import { useContext, useEffect } from "react";
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
        setReply,
        setPrevChats
    } = useContext(MyContext);

    const createNewChat = () => {
        setCurrThreadId(uuidv1());
        setNewChat(true);
        setPrompt("");
        setReply(null);
        setPrevChats([]);
    };
    const changeThread = async (newThreadId) => {
        setCurrThreadId(newThreadId);
        try{
            const response = await apiFetch(`/api/thread/${newThreadId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch thread: ${response.status}`);
            }
            const res = await response.json();
            console.log(res);
            setPrevChats(res);
            setNewChat(false);
            setReply(null);
        }
        catch(err){
            console.log(err);
        }
       
    };

    const deleteThread = async (event, threadId) => {
        event.stopPropagation();

        try {
            const response = await apiFetch(`/api/thread/${threadId}`, {
                method: "DELETE"
            });
            if (!response.ok) {
                throw new Error(`Failed to delete thread: ${response.status}`);
            }

            setAllThreads((threads) => threads.filter((thread) => thread.threadId !== threadId));
            if (currThreadId === threadId) {
                createNewChat();
            }
        } catch (err) {
            console.error(err);
        }
    };

    useEffect(() => {
        const getAllThreads = async () => {
            try {
                const response = await apiFetch("/api/thread");
                if (!response.ok) {
                    throw new Error(`Failed to fetch threads: ${response.status}`);
                }
                const res = await response.json();
                const filtereData = res.map((thread) => ({ threadId: thread.threadId, title: thread.title, }));

                // console.log("Filtered Data:", filtereData);
                setAllThreads(filtereData);
            } catch (err) {
                console.log(err);
            }
        };

        getAllThreads();
    }, [currThreadId, setAllThreads]);
    return (
        <section className="sidebar">
            {/* new chat button */}
            <button onClick={createNewChat} className="newchat">
                <img src={blacklogo} alt="" className="logo" />
                <span><i className="fa-solid fa-pen-to-square"></i></span>
            </button>

            {/*history*/}
            <ul className="history">
                {
                    allThreads?.map((thread, idx) => (
                        <li key={idx} onClick={() => changeThread(thread.threadId)} className={currThreadId === thread.threadId ? "active" : ""}>
                            <span className="thread-title">{thread.title}</span>
                            <button
                                type="button"
                                className="delete-thread"
                                aria-label={`Delete ${thread.title}`}
                                title="Delete thread"
                                onClick={(event) => deleteThread(event, thread.threadId)}
                            >
                                <i className="fa-solid fa-trash-can" aria-hidden="true"></i>
                            </button>
                        </li>
                    ))
                }
            </ul>

            {/*signout*/}
            <div className="sign">
                <p>By Mr Brand❤️</p>
            </div>
        </section>
    );
}

export default Sidebar;