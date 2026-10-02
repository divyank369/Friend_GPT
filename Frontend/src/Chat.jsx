import "./Chat.css";
import { useContext, useEffect, useState } from "react";
import { MyContext } from "./Mycontext";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";


function ChatMessage({ chat }) {
    const [visibleContent, setVisibleContent] = useState(() => chat.animate ? "" : chat.content);

    useEffect(() => {
        if (!chat.animate) return;

        const words = chat.content.match(/\S+\s*/g) || [];
        let visibleWordCount = 0;
        const intervalId = setInterval(() => {
            visibleWordCount += 1;
            setVisibleContent(words.slice(0, visibleWordCount).join(""));
            if (visibleWordCount >= words.length) clearInterval(intervalId);
        }, 40);

        return () => clearInterval(intervalId);
    }, [chat.animate, chat.content]);

    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {chat.animate ? visibleContent : chat.content}
        </ReactMarkdown>
    );
}

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
                                : "gptDiv"
                        }
                        key={`${idx}-${chat.role}-${chat.content}`}
                    >
                        {chat.role === "user" ? (
                            <p className="userMessage">
                                {chat.content}
                            </p>
                        ) : (
                            <ChatMessage chat={chat} />
                        )}
                    </div>
                ))}
            </div>
        </>
    );
}

export default Chat;