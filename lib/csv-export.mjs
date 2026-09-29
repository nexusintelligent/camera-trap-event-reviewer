function exportError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function selectExportEvents(events, parameters) {
  if (!parameters.has("deploymentId")) return { events, deploymentId: null };
  const ids = parameters.getAll("deploymentId");
  if (ids.length !== 1 || !ids[0].trim()) throw exportError(400, "請選擇一個有效的匯出批次。");
  const deploymentId = ids[0];
  const selected = events.filter((event) => event.DeploymentID === deploymentId);
  if (!selected.length) throw exportError(404, "此批次不存在或已被清除，請重新開啟匯出視窗選擇批次。");
  return { events: selected, deploymentId };
}

export function exportDisposition(deploymentId, date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
  const batch = deploymentId === null ? "all-batches" : String(deploymentId)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").slice(0, 100).replace(/[. ]+$/, "") || "batch";
  const filename = `camera_trap_${batch}_${timestamp}.csv`;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="camera_trap_events_${timestamp}.csv"; filename*=UTF-8''${encoded}`;
}
