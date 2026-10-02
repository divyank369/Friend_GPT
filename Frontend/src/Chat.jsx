import "./Chat.css";
import { useContext } from "react";
import { MyContext } from "./Mycontext";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";


function Chat() {
    const { newChat, prevChats } = useContext(MyContext);

    return (
        <>
            {newChat && <h1 className="chat-empty-title">Start a new chat</h1>}

            <div aria-live="polite" className="chats" role="log">
                {prevChats?.map((chat, idx) => (
                    <div
                        className={
                            chat.role === "user"
                                ? "userDiv"
                                : `gptDiv${chat.streaming ? " is-streaming" : ""}`
                        }
                        key={chat.id || chat._id || idx}
                    >
                        {chat.role === "user" ? (
                            <p className="userMessage">
                                {chat.content}
                            </p>
                        ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {chat.content}
                            </ReactMarkdown>
                        )}
                    </div>
                ))}
            </div>
        </>
    );
}

export default Chat;