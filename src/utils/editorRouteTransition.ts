export async function transitionToEditor(navigate: () => void): Promise<void> {
  const main = document.querySelector("main");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !main?.animate) {
    navigate();
    return;
  }

  try {
    const exit = main.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-5px)" }],
      { duration: 160, easing: "ease-out", fill: "forwards" },
    );
    await exit.finished;
  } catch {
    // Navigation must continue if the animation is unavailable or interrupted.
  }
  navigate();
}
