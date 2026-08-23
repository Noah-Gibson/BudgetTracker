export const dynamic = "force-static";

export default function OfflinePage() {
  return <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "1.5rem", background: "#1a1718", color: "#f5eff1", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
    <section><p style={{ color: "#c4b5fd", fontWeight: 800, letterSpacing: ".1em" }}>CIPHER BUDGET</p><h1>You’re offline</h1><p>Reconnect to securely sign in and sync your budget. A remembered personal device can still open its last synced budget from the app.</p></section>
  </main>;
}
