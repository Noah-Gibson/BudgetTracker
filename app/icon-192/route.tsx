import { ImageResponse } from "next/og";

export const runtime = "edge";

export function GET() {
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1a1718", color: "white", fontSize: 112, fontWeight: 800, fontFamily: "sans-serif" }}><div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 36, background: "#8254e8", border: "9px solid #c4b5fd" }}>₿</div></div>, { width: 192, height: 192 });
}
