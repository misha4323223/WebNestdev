import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-прокси идёт на API. В обычной разработке это 8787; когда платформа сама занимает
// 8787 под веб-интерфейс, dev-скрипт поднимает API рядом и передаёт его порт сюда.
const apiPort=process.env.VITE_API_PORT?.trim()||"8787";

export default defineConfig({
  plugins:[react()],
  server:{
    port:5173,
    host:"0.0.0.0",
    proxy:{
      "/api":{target:`http://localhost:${apiPort}`,changeOrigin:true},
      "/ws":{target:`ws://localhost:${apiPort}`,ws:true}
    }
  }
});
