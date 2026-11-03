export type TypedTransportMessage = Record<string, unknown>;

/** Internal transport seam. Wire encoders, authentication, and queues belong to each adapter. */
export interface MessageSocket<
  Outbound extends TypedTransportMessage = TypedTransportMessage,
  Inbound extends TypedTransportMessage = TypedTransportMessage,
> {
  readonly readyState: number;
  /** WebSocket wire operation. Domain code uses sendSocketMessage. */
  send(data: string): void;
  /** Sends an already-decoded domain message without a JSON round trip. */
  sendMessage?(message: Outbound): void;
  /** Subscribes to already-decoded domain messages when the transport supports them. */
  onMessage?(listener: (message: Inbound) => void): () => void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  off?(event: "message", listener: (data: Buffer) => void): this;
}

/** Sends a validated domain message. JSON serialization remains a WebSocket edge concern. */
export function sendSocketMessage<T extends TypedTransportMessage>(
  socket: MessageSocket<T>,
  message: T,
): void {
  if (socket.sendMessage) socket.sendMessage(message);
  else socket.send(JSON.stringify(message));
}

/**
 * Connects a domain handler to either a typed transport or a WebSocket byte transport. The decoder is
 * called only for byte-oriented transports, keeping protobuf messages out of the JSON path.
 */
export function listenSocketMessages<T extends TypedTransportMessage>(
  socket: MessageSocket<TypedTransportMessage, T>,
  decode: (data: Buffer) => T,
  listener: (message: T) => void,
  onDecodeError: (error: unknown) => void = () => socket.close(1007, "Invalid transport message"),
): () => void {
  if (socket.onMessage) return socket.onMessage(listener);
  const receive = (data: Buffer) => {
    let message: T;
    try {
      message = decode(data);
    } catch (error) {
      onDecodeError(error);
      return;
    }
    listener(message);
  };
  socket.on("message", receive);
  return () => socket.off?.("message", receive);
}
