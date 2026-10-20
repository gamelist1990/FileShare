/** P2P download for Fileshare's interactive download button only.
 * Inline video, audio, PDFs and preview URLs remain normal HTTP Range.
 */
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_PENDING = 16 * 1024 * 1024;
function awaitICE(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", change);
      resolve();
    };
    const change = () => { if (peer.iceGatheringState === "complete") finish(); };
    const timer = setTimeout(finish, 6000);
    peer.addEventListener("icegatheringstatechange", change);
  });
}
export async function downloadWebRTC(
  item: { id: string; name: string; size: number },
  onProgress?: (received: number, size: number) => void,
): Promise<boolean> {
  if (typeof RTCPeerConnection === "undefined" || item.size <= 0) return false;
  // On Safari/iOS, large Blob accumulation can terminate the page.
  // Desktop browsers with File System Access API stream directly to disk.
  const picker = (window as any).showSaveFilePicker as undefined | ((arg: any) => Promise<any>);
  if (item.size > MAX_MEMORY_BYTES && !picker) return false;
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const dc = pc.createDataChannel("fileshare-download", { ordered: true });
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let handle: any = null;
  let writable: any = null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let expected = -1;
  let done = false;
  let completedHash: string | null = null;
  let pending = Promise.resolve();
  const output = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("P2P受信がタイムアウトしました")), 30000);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => reject(new Error("P2P受信が途切れました")), 30000);
    };
    dc.onmessage = ({ data }) => {
      reset();
      if (typeof data === "string") {
        let info: any;
        try { info = JSON.parse(data); } catch { reject(new Error("不正な転送応答"));return; }
        if (info.type === "start") {
          if (!Number.isSafeInteger(info.size) || info.size !== item.size) {
            reject(new Error("ファイルサイズが一致しません"));return;
          }
          expected = info.size;
          return;
        }
        if (info.type === "done") {
          if (info.size !== expected) { reject(new Error("転送サイズが不正です")); return; }
          completedHash = typeof info.sha256 === "string" && /^[a-f0-9]{64}$/.test(info.sha256)
            ? info.sha256 : null;
          if (!completedHash) { reject(new Error("整合性情報が不正です"));return; }
          done = true;
          pending.then(() => {
            if (length !== expected) reject(new Error("受信データが不足しています"));
            else resolve();
          }).catch(reject);
          return;
        }
        reject(new Error("P2P転送エラー"));
        return;
      }
      if (expected < 0 || done) { reject(new Error("不正な受信順序")); return; }
      pending = pending.then(async () => {
        const chunk = new Uint8Array(data instanceof ArrayBuffer ? data : await (data as Blob).arrayBuffer());
        if (length + chunk.length > expected) throw new Error("ダウンロードサイズを超えています");
        if (writable) await writable.write(chunk);
        else {
          chunks.push(chunk);
          if (length > MAX_MEMORY_BYTES) throw new Error("メモリ上限を超えています");
        }
        length += chunk.length;
        onProgress?.(length, expected);
      });
      void pending.catch(reject);
    };
    dc.onerror = () => reject(new Error("P2P通信に失敗しました"));
    dc.onclose = () => { if (!done) reject(new Error("接続が切断されました")); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        if (!done) reject(new Error("P2P接続に失敗しました"));
    };
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await awaitICE(pc);
      const response = await fetch("/api/items/" + item.id + "/webrtc/offer", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: pc.localDescription }),
        signal: AbortSignal.timeout(16000),
      });
      if (!response.ok) throw new Error("P2P経路を利用できません");
      const data = await response.json();
      await pc.setRemoteDescription(data.answer);
      // The file picker is only used on browsers supporting streaming saves.
      // No picker is requested for small downloads: they use Blob.
    })().catch(reject);
    void timer;
  });
  try {
    // Desktop streams avoid storing the entire download in RAM.
    if (picker && item.size > MAX_MEMORY_BYTES) {
      // Some browsers require a user activation for a save picker; if that
      // activation is unavailable, the caller will use ordinary HTTPS.
      handle = await picker({ suggestedName: item.name });
      writable = await handle.createWritable();
    }
    await output;
    if (writable) await writable.close();
    else {
      const blob = new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
      // For memory-based downloads, verify the server's full-file digest
      // before handing the payload to the browser's download manager.
      const bytes = await blob.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        b => b.toString(16).padStart(2, "0")).join("");
      if (!completedHash || digest !== completedHash)
        throw new Error("ダウンロードの整合性を確認できません");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = item.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return true;
  } catch {
    try { await writable?.abort(); } catch {}
    return false;
  } finally {
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
  }
}
