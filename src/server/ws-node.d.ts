// npm alias avoids Bun's built-in "ws" shim, which requires a native Bun HTTP listener.
declare module "ws-node" {
  export { default } from "ws";
  export { WebSocketServer, WebSocket } from "ws";
}
