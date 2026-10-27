import { useEffect, useLayoutEffect, useRef } from "react";
import Form from "../components/Form";
import ListFiles from "../components/ListFiles";
import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { verifyMainFolder } from "../utils/helpers";
import type { Component } from "../utils/types";
import { useShallow } from "zustand/react/shallow";
import { getListScroll, setListScroll } from "../utils/listScroll";

function getScrollPos(): number {
  return (
    window.pageYOffset ||
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0
  );
}

function applyScroll(y: number): void {
  window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
  if (document.documentElement && document.documentElement.scrollTop !== y) {
    document.documentElement.scrollTop = y;
  }
  if (document.body && document.body.scrollTop !== y) {
    document.body.scrollTop = y;
  }
}

function List(): Component {
  const { getFilesWithStats } = useFile(),
    { setFilesWithStats, fileIsEdited, files } = fileStore(
      useShallow(state => ({
        setFilesWithStats: state.setFilesWithStats,
        fileIsEdited: state.fileIsEdited,
        files: state.files,
      }))
    ),
    isRestoringScrollRef = useRef<boolean>(false);

  useLayoutEffect(() => {
    const targetY = getListScroll();
    if (targetY <= 0) return;

    isRestoringScrollRef.current = true;
    applyScroll(targetY);

    let rafId: number;
    const startTime = performance.now();

    const onUserScrollGesture = (e: Event): void => {
      if (e.type === "keydown") {
        const key = (e as KeyboardEvent).key;
        const scrollKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
        if (!scrollKeys.includes(key)) return;
      }
      isRestoringScrollRef.current = false;
      cancelAnimationFrame(rafId);
      cleanupGestureListeners();
    };

    const cleanupGestureListeners = (): void => {
      window.removeEventListener("wheel", onUserScrollGesture);
      window.removeEventListener("touchmove", onUserScrollGesture);
      window.removeEventListener("keydown", onUserScrollGesture);
    };

    window.addEventListener("wheel", onUserScrollGesture, { passive: true });
    window.addEventListener("touchmove", onUserScrollGesture, { passive: true });
    window.addEventListener("keydown", onUserScrollGesture, { passive: true });

    const step = (time: number): void => {
      if (!isRestoringScrollRef.current) return;

      const currentY = getScrollPos();
      if (Math.abs(currentY - targetY) > 1) {
        applyScroll(targetY);
      }

      if (time - startTime < 500) {
        rafId = requestAnimationFrame(step);
      } else {
        isRestoringScrollRef.current = false;
        cleanupGestureListeners();
      }
    };

    rafId = requestAnimationFrame(step);

    return () => {
      isRestoringScrollRef.current = false;
      cancelAnimationFrame(rafId);
      cleanupGestureListeners();
    };
  }, []);

  useEffect(() => {
    let isAlive = true;
    let hasUserScrolled = false;

    const onUserScrollInput = (e: Event): void => {
      if (e.type === "keydown") {
        const key = (e as KeyboardEvent).key;
        const scrollKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
        if (!scrollKeys.includes(key)) return;
      }
      hasUserScrolled = true;
    };

    window.addEventListener("wheel", onUserScrollInput, { passive: true });
    window.addEventListener("touchmove", onUserScrollInput, { passive: true });
    window.addEventListener("keydown", onUserScrollInput, { passive: true });

    const handleScroll = (): void => {
      if (!isAlive || isRestoringScrollRef.current) return;
      const y = getScrollPos();

      if (y > 0) {
        setListScroll(y);
      } else if (hasUserScrolled) {
        setListScroll(0);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      isAlive = false;
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("wheel", onUserScrollInput);
      window.removeEventListener("touchmove", onUserScrollInput);
      window.removeEventListener("keydown", onUserScrollInput);
      const currentY = getScrollPos();
      if (currentY > 0) {
        setListScroll(currentY);
      }
    };
  }, []);

  useEffect(() => {
    const targetY = getListScroll();
    if (targetY <= 0) return;
    const currentY = getScrollPos();
    if (Math.abs(currentY - targetY) > 2) {
      applyScroll(targetY);
    }
  }, [files]);

  useEffect(() => {
    async function init() {
      await verifyMainFolder();
      const { files: filesList, stats } = await getFilesWithStats();
      setFilesWithStats(filesList, stats);
    }
    init();
  }, [fileIsEdited]);

  return (
    <MainContainer>
      <div className="flex flex-col items-center justify-start w-full min-h-screen pt-14 sm:pt-20 px-4 pb-12">
        <div className="w-[680px] max-w-full flex flex-col items-center gap-y-6 sm:gap-y-8">
          <Form />
          <ListFiles arr={files} />
        </div>
      </div>
    </MainContainer>
  );
}

export default List;
