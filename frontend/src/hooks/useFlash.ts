"use client";

import { useEffect, useRef } from "react";
import { PRICE_FLASH_MS } from "@/config";
import { flashFor } from "@/logic/flash";

/**
 * Briefly apply `flash-up` / `flash-down` to the returned element when `price` changes,
 * then remove it. Works on the DOM directly so a tick doesn't cost an extra render.
 */
export function useFlash<T extends HTMLElement>(price: number | null | undefined) {
  const ref = useRef<T>(null);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const dir = flashFor(previous.current, price);
    if (price != null) previous.current = price;
    const el = ref.current;
    if (!dir || !el) return;
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth; // restart the animation if the previous flash is still running
    el.classList.add(dir === "up" ? "flash-up" : "flash-down");
    const timer = setTimeout(() => el.classList.remove("flash-up", "flash-down"), PRICE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [price]);

  return ref;
}
