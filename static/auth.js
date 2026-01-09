(() => {
  function initPasswordToggles() {
    const inputs = document.querySelectorAll('input[data-pw="1"]');
    for (const input of inputs) {
      const wrap = input.closest(".pwWrap");
      const btn = wrap ? wrap.querySelector(".pwToggle") : null;
      if (!btn) continue;

      const sync = () => {
        const isText = input.type === "text";
        btn.textContent = isText ? "隐藏" : "显示";
        btn.setAttribute("aria-label", isText ? "隐藏密码" : "显示密码");
      };

      btn.addEventListener("click", () => {
        input.type = input.type === "password" ? "text" : "password";
        sync();
        input.focus();
      });

      sync();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPasswordToggles);
  } else {
    initPasswordToggles();
  }
})();

