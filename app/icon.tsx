import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1a1718", color: "white", fontSize: 300, fontWeight: 800, fontFamily: "sans-serif" }}>
      <div style={{ width: 400, height: 400, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 96, background: "#8254e8", border: "24px solid #c4b5fd" }}>₿</div>
    </div>
  );
}
