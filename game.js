(() => {
  "use strict";

  // Fill these in after creating a Supabase project. The public anon key is
  // designed for browser use; security comes from the RLS policies in schema.sql.
  const backend = {
    url: "https://hbspwnhddcraepdbqeni.supabase.co",
    anonKey: "sb_publishable_rUFafb7VlBAqAu8bvIOTvQ_d9Ts92yn"
  };
  const configured = Boolean(backend.url && backend.anonKey);
  const apiRoot = backend.url.replace(/\/$/, "");
  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#jump-canvas");
  const ctx = canvas.getContext("2d");
  const overlay = $("#game-overlay");
  const startButton = $("#game-start");
  const accountModal = $("#account-modal");
  const accountForm = $("#account-form");
  const STORAGE_KEY = "soon-nearby-jump-v1";
  const SESSION_KEY = "soon-nearby-session-v1";
  const WIDTH = 420;
  const HEIGHT = 560;
  const GRAVITY = 0.28;
  const JUMP = -10.6;

  let saved = readJSON(STORAGE_KEY, { best: 0, name: "" });
  let session = readJSON(SESSION_KEY, null);
  let createAccount = true;
  let isPasswordRecovery = false;
  let rows = [];
  let topRival = null;
  let game = null;
  let animationId = 0;
  let direction = 0;
  let activeTouch = null;
  let lastStats = "";

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }

  function setMessage(message) {
    $("#account-message").textContent = message;
  }

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = { apikey: backend.anonKey, "Content-Type": "application/json" };
    if (auth && session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const response = await fetch(`${apiRoot}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || "Не получилось связаться с сервером.");
    return data;
  }

  function setAccountUI() {
    const loggedIn = configured && Boolean(session?.access_token);
    $("#account-open").textContent = loggedIn ? `${session.user?.user_metadata?.display_name || saved.name || "Игрок"} · Выйти` : (saved.name ? `${saved.name} · аккаунт` : "Войти / создать аккаунт");
    $("#leader-status").textContent = configured ? "Общий рейтинг" : "Локальный режим";
    $("#leader-status").classList.toggle("connected", configured);
    $("#leader-note").textContent = configured
      ? (loggedIn ? `Вы вошли как ${session.user?.user_metadata?.display_name || saved.name}. Рекорд сохранится в общей таблице.` : "Войди или создай аккаунт, чтобы отправить рекорд в общую таблицу.")
      : "Общий рейтинг появится после подключения общей базы данных. Сейчас имя и рекорд хранятся только в этом браузере.";
  }

  function renderLeaderboard() {
    const host = $("#leader-content");
    host.replaceChildren();
    if (!configured) {
      const empty = document.createElement("p");
      empty.className = "leader-empty";
      empty.textContent = "Пока рекорды сохраняются только на этом устройстве. Подключим общую базу — здесь появится таблица для всех игроков.";
      host.append(empty);
      topRival = null;
      updateStats();
      return;
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "leader-empty";
      empty.textContent = "Рекордов пока нет. Стань первым игроком в таблице!";
      host.append(empty);
      topRival = null;
      updateStats();
      return;
    }

    const list = document.createElement("ol");
    list.className = "leader-list";
    rows.slice(0, 10).forEach((player, index) => {
      const item = document.createElement("li");
      item.className = "leader-row";
      const rank = document.createElement("span");
      rank.className = "leader-rank";
      rank.textContent = `${index + 1}`;
      const name = document.createElement("span");
      name.className = "leader-name";
      name.textContent = player.display_name;
      const score = document.createElement("span");
      score.className = "leader-points";
      score.textContent = `${Number(player.best_score).toLocaleString("ru-RU")} очков`;
      item.append(rank, name, score);
      list.append(item);
    });
    host.append(list);
    const myId = session?.user?.id;
    topRival = rows.find((player) => player.id !== myId) || (myId ? null : rows[0]);
    updateStats();
  }

  async function refreshLeaderboard() {
    if (!configured) return;
    try {
      rows = await api("/rest/v1/profiles?select=id,display_name,best_score&order=best_score.desc&limit=10");
      renderLeaderboard();
      const myId = session?.user?.id;
      if (myId) {
        const mine = rows.find((player) => player.id === myId);
        if (mine) {
          saved.best = Math.max(Number(saved.best) || 0, Number(mine.best_score) || 0);
          saved.name = mine.display_name;
          saveLocal();
        }
      }
    } catch (error) {
      $("#leader-status").textContent = "Нет соединения";
      const empty = document.createElement("p");
      empty.className = "leader-empty";
      empty.textContent = `Не удалось загрузить общий рейтинг. ${error.message}`;
      $("#leader-content").replaceChildren(empty);
    }
  }

  async function ensureSession() {
    if (!configured || !session?.refresh_token) return false;
    const expiry = session.expires_at ? session.expires_at * 1000 : 0;
    if (!expiry || expiry > Date.now() + 60_000) return Boolean(session.access_token);
    try {
      session = await api("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: session.refresh_token }
      });
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      setAccountUI();
      return true;
    } catch {
      session = null;
      localStorage.removeItem(SESSION_KEY);
      setAccountUI();
      return false;
    }
  }

  function updateStats() {
    const score = game?.score ?? 0;
    const best = Number(saved.best) || 0;
    const bestDelta = best - score;
    const rivalScore = Number(topRival?.best_score) || 0;
    const rivalDelta = rivalScore - score;
    const state = `${score}|${best}|${rivalScore}|${Boolean(game?.running)}`;
    if (state === lastStats) return;
    lastStats = state;
    $("#game-score").textContent = score.toLocaleString("ru-RU");
    $("#game-to-best").textContent = score > 0 && score > best ? "Новый!" : (best ? Math.max(0, bestDelta).toLocaleString("ru-RU") : "первый!");
    $("#game-to-leader").textContent = rivalScore ? (rivalDelta > 0 ? rivalDelta.toLocaleString("ru-RU") : "Обогнал!") : "—";
    $("#game-to-best").title = best ? `Твой личный рекорд: ${best}` : "Сыграй первую игру, чтобы установить рекорд";
    $("#game-to-leader").title = topRival ? `Рекорд игрока ${topRival.display_name}: ${rivalScore}` : "Пока нет рекорда соперника";
  }

  function setMode(isCreate) {
    isPasswordRecovery = false;
    createAccount = isCreate;
    $("#account-title").textContent = configured ? (isCreate ? "Новый аккаунт" : "С возвращением") : "Имя игрока";
    $("#account-description").textContent = configured
      ? "Аккаунт сохранит твой рекорд и покажет его всем игрокам."
      : "Сейчас можно сохранить имя и рекорд на этом устройстве. Общий рейтинг заработает после подключения базы данных.";
    $("#player-name-field").hidden = configured && !isCreate;
    $("#player-name").required = !configured || isCreate;
    $("#player-email").parentElement.hidden = !configured;
    $("#player-password").parentElement.hidden = !configured;
    $("#player-email").required = configured;
    $("#player-password").required = configured;
    $("#account-submit").textContent = configured ? (isCreate ? "Создать аккаунт" : "Войти") : "Сохранить имя";
    $("#account-switch").hidden = !configured;
    $("#account-switch").textContent = isCreate ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Создать";
    $("#forgot-password").hidden = !configured || isCreate;
    $("#confirm-password-field").hidden = true;
    $("#confirm-password").required = false;
    $("#password-field").hidden = !configured;
    $("#password-field").firstChild.textContent = "Пароль";
    $("#player-password").autocomplete = isCreate ? "new-password" : "current-password";
    $("#player-name").value = saved.name || "";
    setMessage("");
  }

  function showPasswordReset() {
    setMode(false);
    isPasswordRecovery = true;
    $("#account-title").textContent = "Новый пароль";
    $("#account-description").textContent = "Придумай новый пароль длиной не меньше 8 символов.";
    $("#player-name-field").hidden = true;
    $("#player-email").parentElement.hidden = true;
    $("#player-email").required = false;
    $("#password-field").hidden = false;
    $("#password-field").firstChild.textContent = "Новый пароль";
    $("#player-password").autocomplete = "new-password";
    $("#confirm-password-field").hidden = false;
    $("#confirm-password").required = true;
    $("#account-submit").textContent = "Сохранить пароль";
    $("#account-switch").hidden = true;
    $("#forgot-password").hidden = true;
  }

  async function requestPasswordReset() {
    const email = $("#player-email").value.trim();
    if (!email) {
      $("#player-email").focus();
      setMessage("Сначала введи email своего аккаунта.");
      return;
    }
    const button = $("#forgot-password");
    button.disabled = true;
    button.textContent = "Отправляем письмо…";
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      await api(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        body: { email }
      });
      setMessage("Если аккаунт с таким email существует, письмо со ссылкой уже отправлено.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Забыли пароль?";
    }
  }

  function handlePasswordRecoveryLink() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.get("type") !== "recovery" || !params.get("access_token")) return;
    const expiresIn = Number(params.get("expires_in")) || 3600;
    session = {
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token"),
      token_type: params.get("token_type") || "bearer",
      expires_in: expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn
    };
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    showPasswordReset();
    accountModal.hidden = false;
    $("#player-password").focus();
  }

  function openAccount() {
    if (configured && session?.access_token) {
      if (confirm("Выйти из аккаунта? Личный рекорд останется в общей таблице.")) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
        setAccountUI();
        refreshLeaderboard();
      }
      return;
    }
    setMode(configured);
    accountModal.hidden = false;
    $("#player-name").focus();
  }

  async function submitAccount(event) {
    event.preventDefault();
    if (isPasswordRecovery) {
      const password = $("#player-password").value;
      if (password.length < 8) return setMessage("Пароль должен быть не короче 8 символов.");
      if (password !== $("#confirm-password").value) return setMessage("Пароли не совпадают.");
      const button = $("#account-submit");
      button.disabled = true;
      button.textContent = "Сохраняем…";
      try {
        await api("/auth/v1/user", { method: "PUT", auth: true, body: { password } });
        session = null;
        localStorage.removeItem(SESSION_KEY);
        setMode(false);
        accountModal.hidden = false;
        setMessage("Пароль обновлён. Теперь войди с новым паролем.");
      } catch (error) {
        setMessage(error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Войти";
      }
      return;
    }
    const name = $("#player-name").value.trim().replace(/\s+/g, " ");
    if (!configured) {
      if (!name) return setMessage("Введи имя, чтобы сохранить личный рекорд.");
      saved.name = name.slice(0, 20);
      saveLocal();
      setAccountUI();
      accountModal.hidden = true;
      return;
    }
    const email = $("#player-email").value.trim();
    const password = $("#player-password").value;
    const button = $("#account-submit");
    button.disabled = true;
    button.textContent = "Подожди…";
    try {
      let result;
      if (createAccount) {
        result = await api("/auth/v1/signup", { method: "POST", body: { email, password, data: { display_name: name } } });
        if (!result.access_token) {
          setMode(false);
          setMessage("Проверь почту и подтверди адрес, затем войди в аккаунт.");
          return;
        }
      } else {
        result = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      }
      session = result;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      saved.name = session.user?.user_metadata?.display_name || name || saved.name;
      saveLocal();
      setAccountUI();
      accountModal.hidden = true;
      await refreshLeaderboard();
    } catch (error) {
      setMessage(error.message);
    } finally {
      button.disabled = false;
      button.textContent = createAccount ? "Создать аккаунт" : "Войти";
    }
  }

  function resizeCanvas() {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(WIDTH * scale);
    canvas.height = Math.round(HEIGHT * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw();
  }

  function newGame() {
    const platforms = [];
    let y = HEIGHT - 28;
    while (y > -HEIGHT) {
      platforms.push({ x: 24 + Math.random() * (WIDTH - 104), y, width: 76, moving: Math.random() > 0.72, phase: Math.random() * Math.PI * 2 });
      y -= 58 + Math.random() * 31;
    }
    return {
      x: WIDTH / 2,
      y: HEIGHT - 92,
      vy: JUMP,
      camera: 0,
      startY: HEIGHT - 92,
      score: 0,
      running: true,
      platforms,
      lastFrame: 0
    };
  }

  function startGame() {
    cancelAnimationFrame(animationId);
    game = newGame();
    lastStats = "";
    overlay.hidden = true;
    updateStats();
    animationId = requestAnimationFrame(frame);
  }

  function endGame() {
    if (!game?.running) return;
    game.running = false;
    const isNewRecord = game.score > (Number(saved.best) || 0);
    if (isNewRecord) {
      saved.best = game.score;
      saveLocal();
    }
    updateStats();
    $("#game-overlay-title").textContent = isNewRecord ? "Новый рекорд!" : "Почти получилось!";
    $("#game-overlay-copy").textContent = `${saved.name ? `${saved.name}, ` : ""}твой счёт — ${game.score.toLocaleString("ru-RU")} очков. Ещё попытка?`;
    startButton.textContent = "Играть ещё";
    overlay.hidden = false;
    if (configured && session?.access_token && game.score > 0) submitScore(game.score);
  }

  async function submitScore(score) {
    try {
      if (!await ensureSession()) throw new Error("Войди в аккаунт, чтобы сохранить рекорд в общем рейтинге.");
      await api("/rest/v1/rpc/submit_score", { method: "POST", auth: true, body: { score_in: score } });
      await refreshLeaderboard();
    } catch (error) {
      $("#leader-note").textContent = `Рекорд пока не отправлен: ${error.message}`;
    }
  }

  function frame(now) {
    if (!game?.running) return;
    const dt = Math.min(2, Math.max(0.4, (now - (game.lastFrame || now - 16.67)) / 16.67));
    game.lastFrame = now;
    update(dt, now);
    draw(now);
    updateStats();
    animationId = requestAnimationFrame(frame);
  }

  function update(dt, now) {
    const oldY = game.y;
    game.x += direction * 5.3 * dt;
    if (activeTouch !== null) game.x += (activeTouch - game.x) * Math.min(0.28 * dt, 1);
    if (game.x < -12) game.x = WIDTH + 12;
    if (game.x > WIDTH + 12) game.x = -12;

    game.vy += GRAVITY * dt;
    game.y += game.vy * dt;

    if (game.vy > 0) {
      for (const platform of game.platforms) {
        const platformX = platform.x + (platform.moving ? Math.sin(now / 700 + platform.phase) * 38 : 0);
        if (oldY + 18 <= platform.y && game.y + 18 >= platform.y && game.x + 13 > platformX && game.x - 13 < platformX + platform.width) {
          game.y = platform.y - 18;
          game.vy = JUMP;
          break;
        }
      }
    }

    const screenY = game.y + game.camera;
    if (screenY < 205) game.camera += 205 - screenY;
    game.score = Math.max(game.score, Math.floor((game.startY - game.y) / 5));

    game.platforms = game.platforms.filter((p) => p.y + game.camera < HEIGHT + 36);
    let minY = Math.min(...game.platforms.map((p) => p.y), HEIGHT);
    while (minY + game.camera > -45) {
      minY -= 58 + Math.random() * 31;
      game.platforms.push({ x: 24 + Math.random() * (WIDTH - 104), y: minY, width: 76, moving: Math.random() > 0.72, phase: Math.random() * Math.PI * 2 });
    }

    if (game.y + game.camera > HEIGHT + 35) endGame();
  }

  function drawBackground() {
    const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, "#f8e9e1");
    gradient.addColorStop(0.55, "#fbf5ef");
    gradient.addColorStop(1, "#eee8f3");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "rgba(189,102,113,.12)";
    for (let i = 0; i < 30; i++) {
      const x = (i * 83 + 25) % WIDTH;
      const y = (i * 137 + (game?.camera || 0) * 0.16) % HEIGHT;
      ctx.beginPath();
      ctx.arc(x, y, i % 4 === 0 ? 2 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPlatform(x, y, width) {
    ctx.fillStyle = "#fffdfa";
    ctx.strokeStyle = "#d9b9b4";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, 12, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#dfadb0";
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + 3, width * .35, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayer(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(98,63,68,.12)";
    ctx.beginPath(); ctx.ellipse(0, 19, 15, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fffdfa";
    ctx.strokeStyle = "#bd6671";
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(-7, -15, 4, 10, -.18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(7, -15, 4, 10, .18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e9b9b7";
    ctx.beginPath(); ctx.ellipse(-7, -15, 1.7, 6, -.18, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(7, -15, 1.7, 6, .18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fffdfa";
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#443638";
    ctx.beginPath(); ctx.arc(-5, -1, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(5, -1, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e9adb0";
    ctx.beginPath(); ctx.arc(-9, 4, 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(9, 4, 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#bd6671"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-2, 5); ctx.quadraticCurveTo(0, 8, 2, 5); ctx.stroke();
    ctx.restore();
  }

  function draw(now = performance.now()) {
    drawBackground();
    if (!game) {
      for (let i = 0; i < 7; i++) drawPlatform(25 + ((i * 67 + 15) % 300), HEIGHT - 36 - i * 70, 76);
      drawPlayer(WIDTH / 2, HEIGHT - 92);
      return;
    }
    for (const platform of game.platforms) {
      const x = platform.x + (platform.moving ? Math.sin(now / 700 + platform.phase) * 38 : 0);
      const y = platform.y + game.camera;
      if (y > -20 && y < HEIGHT + 20) drawPlatform(x, y, platform.width);
    }
    drawPlayer(game.x, game.y + game.camera);
  }

  document.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "a", "A", "d", "D"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") direction = -1;
    if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") direction = 1;
    if ((event.key === " " || event.key === "Enter") && !game?.running) startGame();
  });
  document.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "a", "A", "d", "D"].includes(event.key)) direction = 0;
  });
  document.querySelectorAll(".game-control").forEach((button) => {
    const press = (event) => { event.preventDefault(); direction = Number(button.dataset.direction); };
    const release = () => { direction = 0; };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
  });
  canvas.addEventListener("pointerdown", (event) => {
    if (!game?.running) return;
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    activeTouch = ((event.clientX - rect.left) / rect.width) * WIDTH;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (game?.running && event.buttons) {
      const rect = canvas.getBoundingClientRect();
      activeTouch = ((event.clientX - rect.left) / rect.width) * WIDTH;
    }
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) => canvas.addEventListener(name, () => { activeTouch = null; }));

  startButton.addEventListener("click", startGame);
  $("#account-open").addEventListener("click", openAccount);
  $("#account-close").addEventListener("click", () => { accountModal.hidden = true; });
  accountModal.addEventListener("click", (event) => { if (event.target === accountModal) accountModal.hidden = true; });
  $("#account-switch").addEventListener("click", () => setMode(!createAccount));
  $("#forgot-password").addEventListener("click", requestPasswordReset);
  accountForm.addEventListener("submit", submitAccount);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") accountModal.hidden = true; });

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  if (!configured) renderLeaderboard();
  setAccountUI();
  if (configured) refreshLeaderboard();
  else updateStats();
  handlePasswordRecoveryLink();
  if (session?.access_token) {
    const expiry = session.expires_at ? session.expires_at * 1000 : 0;
    if (expiry && expiry < Date.now()) {
      session = null;
      localStorage.removeItem(SESSION_KEY);
      setAccountUI();
    }
  }
})();

