import "./Chat.css";
import { useContext, useEffect, useRef, useState } from "react";
import { MyContext } from "./Mycontext";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

function LatestReply({ chat }) {
    const isStreaming = Boolean(chat.streaming);
    const [latestReply, setLatestReply] = useState(() => isStreaming ? "" : chat.content || "");
    const replyState = useRef({ content: chat.content || "", streaming: isStreaming });
    const revealedWordCount = useRef(0);
    const shouldAnimate = useRef(isStreaming);

    useEffect(() => {
        replyState.current = {
            content: chat.content || "",
            streaming: Boolean(chat.streaming)
        };
    }, [chat.content, chat.streaming]);

    useEffect(() => {
        if (!shouldAnimate.current) return;

        const interval = setInterval(() => {
            const currentReply = replyState.current;
            const words = currentReply.content.match(/\s*\S+\s*/g) || [];
            if (currentReply.streaming && currentReply.content && !/\s$/.test(currentReply.content)) {
                words.pop();
            }

            if (revealedWordCount.current < words.length) {
                revealedWordCount.current += 1;
                setLatestReply(words.slice(0, revealedWordCount.current).join(""));
                return;
            }

            if (!currentReply.streaming) {
                setLatestReply(currentReply.content);
                clearInterval(interval);
            }
        }, 40);

        return () => clearInterval(interval);
    }, []);

    return (
        <div className={`gptDiv${isStreaming ? " is-streaming" : ""}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {latestReply}
            </ReactMarkdown>
        </div>
    );
}

function Chat() {
    const { newChat, prevChats } = useContext(MyContext);
    const latestChat = prevChats?.[prevChats.length - 1];
    const latestChatIsAssistant = latestChat?.role === "assistant";
    const latestReplyId = latestChatIsAssistant
        ? latestChat.id || latestChat._id || latestChat.timestamp || "latest-assistant"
        : null;
    const previousChats = latestReplyId ? prevChats.slice(0, -1) : prevChats;

    return (
        <>
            {newChat && <h1 className="chat-empty-title">Start a new chat</h1>}

            <div aria-live="polite" className="chats" role="log">
                {previousChats?.map((chat, idx) => (
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
                {latestReplyId && (
                    <LatestReply chat={latestChat} key={latestReplyId} />
                )}
            </div>
        </>
    );
}

export default Chat;