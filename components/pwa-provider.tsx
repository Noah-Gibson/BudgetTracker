"use client";

import { useEffect, useState } from "react";

const INSTALL_TIP_KEY = "cipher-budget-ios-install-tip-dismissed";

function isIosSafari() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [showTip, setShowTip] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setShowTip(isIosSafari() && !standalone && !localStorage.getItem(INSTALL_TIP_KEY));
  }, []);
  return <>{children}{showTip && <aside className="ios-install-tip" role="status"><span><strong>Use Cipher Budget like an app</strong><small>In Safari, tap Share, then Add to Home Screen.</small></span><button type="button" aria-label="Dismiss install tip" onClick={() => { localStorage.setItem(INSTALL_TIP_KEY, "1"); setShowTip(false); }}>×</button></aside>}</>;
}
