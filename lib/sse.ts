/** 读一个 SSE 响应体，逐帧 JSON.parse 后回调。坏帧忽略。 */
export async function readSse<T>(
  resp: Response,
  onEvent: (ev: T) => void,
): Promise<void> {
  if (!resp.body) throw new Error("no response body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(frame.slice(6)) as T);
      } catch {
        // 忽略坏帧
      }
    }
  }
}
