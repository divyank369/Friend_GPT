 import express from "express";
 import "dotenv/config"; 
 import cors from "cors";
 import cookieParser from "cookie-parser";
 import mongoose from "mongoose";
 import chatRoutes from "./routes/chat.js";
 import authRoutes from "./routes/auth.js";


 const app = express();

 const PORT = process.env.PORT || 8080;
  app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    credentials: true
  }));
  app.use(express.json());
  app.use(cookieParser());


  app.use("/api/auth", authRoutes);
  app.use("/api", chatRoutes);

  app.get("/health", (_req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    res.status(databaseReady ? 200 : 503).json({
      status: databaseReady ? "ok" : "database-unavailable"
    });
  });

 const connectDB = async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("Connected to MongoDB");
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
    }
  };
connectDB();  
 app.listen(PORT, () => {
   console.log(`Server is running on port ${PORT}`);
   
 });
// app.post("/test", async (req, res) => {

//   const options = {
//     method: "POST", 
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
//     },
//     body: JSON.stringify({
//       model: "openai/gpt-oss-20b",
//       messages: [
//         {
//           role: "user",
//           content: req.body.message
//         }
//       ]
//     })
//   };
//   try{
//     const response = await fetch("https://api.groq.com/openai/v1/chat/completions", options);
//     const data = await response.json();
//     console.log(data.choices[0].message.content);
//     res.send(data.choices[0].message.content);
    
//   }catch(err){
//      console.error(err);
//   }

// });

