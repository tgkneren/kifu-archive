const DEFAULT_SIZE = 19;
const STAR_POINTS = {
  9: [2, 4, 6],
  13: [3, 6, 9],
  19: [3, 9, 15],
};

class GobanBoard extends HTMLElement {
  static get observedAttributes() {
    return ["size", "disabled", "readonly", "stone-style", "coordinates", "target-marker"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.size = DEFAULT_SIZE;
    this.stoneStyle = "classic";
    this.showCoordinates = true;
    this.showTargetMarker = true;
    this.stones = new Map();
    this.prisoners = { black: 0, white: 0 };
    this.metadata = {
      blackName: "",
      whiteName: "",
      event: "",
      gameName: "",
      komi: "6.5",
      result: "",
      rules: "Japanese",
      handicap: "",
    };
    this.currentColor = "black";
    this.nodeId = 0;
    this.rootNode = this.createRootNode();
    this.currentNode = this.rootNode;
    this.lastIllegalReason = null;
    this.hoverPoint = null;
    this.targetPoint = null;
    this.activePointerId = null;
    this.pointerStart = null;
    this.isPanning = false;
    this.lastTap = { time: 0, point: null };
    this.skipNextPlacement = false;
    this.zoom = { scale: 1, center: { x: 9, y: 9 }, offsetX: 0, offsetY: 0 };
    this.pixelRatio = 1;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --goban-board: #dcae62;
          --goban-line: #2e1e10;
          --goban-black: #161616;
          --goban-white: #f5f1e7;
          --goban-focus: #28666e;
          display: block;
          width: min(100%, 92vmin);
          max-width: 720px;
          aspect-ratio: 1;
          touch-action: none;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }

        .wrap {
          position: relative;
          width: 100%;
          height: 100%;
        }

        canvas {
          display: block;
          width: 100%;
          height: 100%;
          border-radius: 8px;
          box-shadow: 0 16px 40px rgb(0 0 0 / 18%);
          cursor: pointer;
        }

        :host([disabled]) canvas {
          cursor: not-allowed;
          opacity: 0.7;
        }

        :host([readonly]) canvas {
          cursor: default;
        }

        canvas:focus-visible {
          outline: 3px solid var(--goban-focus);
          outline-offset: 4px;
        }
      </style>
      <div class="wrap">
        <canvas part="canvas" role="application" aria-label="19 by 19 Go board" tabindex="0"></canvas>
      </div>
    `;

    this.canvas = this.shadowRoot.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.resizeObserver = new ResizeObserver(() => this.resize());

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  connectedCallback() {
    this.syncAttributes();
    this.resizeObserver.observe(this);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerLeave);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("keydown", this.onKeyDown);
    this.resize();
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerLeave);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
  }

  attributeChangedCallback() {
    this.syncAttributes();
    this.resize();
  }

  setStones(stones) {
    this.stones.clear();
    for (const stone of stones) {
      this.setStone(stone.x, stone.y, stone.color, { silent: true });
    }
    this.resetGameTree();
    this.draw();
  }

  setStone(x, y, color = this.currentColor, options = {}) {
    if (!this.isOnBoard(x, y) || !["black", "white"].includes(color)) return false;
    this.stones.set(this.key(x, y), color);
    if (!options.silent) this.draw();
    return true;
  }

  clearStone(x, y) {
    const removed = this.stones.delete(this.key(x, y));
    if (removed) this.draw();
    return removed;
  }

  clear() {
    this.stones.clear();
    this.resetPrisoners();
    this.currentColor = "black";
    this.resetGameTree();
    this.draw();
  }

  getStone(x, y) {
    return this.stones.get(this.key(x, y)) ?? null;
  }

  getStones() {
    return [...this.stones.entries()].map(([key, color]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, color };
    });
  }

  getPrisoners() {
    return { ...this.prisoners };
  }

  getLastMove() {
    return this.currentNode.move ? { ...this.currentNode.move } : null;
  }

  isInteractionLocked() {
    return this.hasAttribute("disabled") || this.hasAttribute("readonly");
  }

  canUndo() {
    return this.currentNode !== this.rootNode;
  }

  undo() {
    return this.stepBackward(1, "goban-undo");
  }

  stepBackward(count = 1, eventName = "goban-navigate") {
    if (!this.canUndo()) return false;

    let moved = 0;
    while (moved < count && this.currentNode !== this.rootNode) {
      this.currentNode = this.currentNode.parent;
      moved += 1;
    }

    this.restoreSnapshot(this.currentNode.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation(eventName, { moved });
    return moved > 0;
  }

  stepForward(count = 1) {
    if (!this.canRedo()) return false;

    let moved = 0;
    while (moved < count && this.currentNode.children.length > 0) {
      this.currentNode = this.currentNode.children[0];
      moved += 1;
    }

    this.restoreSnapshot(this.currentNode.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation("goban-navigate", { moved });
    return moved > 0;
  }

  jumpBy(count) {
    return count < 0 ? this.stepBackward(Math.abs(count)) : this.stepForward(count);
  }

  jumpToStart() {
    if (!this.canUndo()) return false;
    let moved = 0;
    while (this.currentNode !== this.rootNode) {
      this.currentNode = this.currentNode.parent;
      moved += 1;
    }
    this.restoreSnapshot(this.currentNode.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation("goban-navigate", { moved });
    return true;
  }

  jumpToEnd() {
    if (!this.canRedo()) return false;
    let moved = 0;
    while (this.currentNode.children.length > 0) {
      this.currentNode = this.currentNode.children[0];
      moved += 1;
    }
    this.restoreSnapshot(this.currentNode.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation("goban-navigate", { moved });
    return true;
  }

  canRedo() {
    return this.currentNode.children.length > 0;
  }

  getMoveNumber() {
    let count = 0;
    let node = this.currentNode;
    while (node && node !== this.rootNode) {
      count += 1;
      node = node.parent;
    }
    return count;
  }

  getMainLineLength() {
    let count = this.getMoveNumber();
    let node = this.currentNode;
    while (node.children.length > 0) {
      count += 1;
      node = node.children[0];
    }
    return count;
  }

  getNavigationState() {
    return {
      canBackward: this.canUndo(),
      canForward: this.canRedo(),
      moveNumber: this.getMoveNumber(),
      mainLineLength: this.getMainLineLength(),
      prisoners: this.getPrisoners(),
      nextColor: this.currentColor,
      variations: this.getVariations(),
    };
  }

  dispatchNavigation(eventName = "goban-navigate", detail = {}) {
    this.dispatchEvent(
      new CustomEvent(eventName, {
        bubbles: true,
        composed: true,
        detail: { ...this.getNavigationState(), ...detail },
      })
    );
  }

  getVariations() {
    return this.currentNode.children.map((node, index) => ({
      index,
      id: node.id,
      move: { ...node.move },
      comment: node.comment ?? "",
    }));
  }

  getCurrentComment() {
    return this.currentNode.comment ?? "";
  }

  setCurrentComment(comment = "") {
    if (this.currentNode === this.rootNode) return false;
    this.currentNode.comment = String(comment);
    this.dispatchNavigation("goban-comment", { comment: this.currentNode.comment });
    return true;
  }

  playVariation(index = 0) {
    const node = this.currentNode.children[index];
    if (!node) return false;

    this.currentNode = node;
    this.restoreSnapshot(node.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchEvent(
      new CustomEvent("goban-variation", {
        bubbles: true,
        composed: true,
        detail: {
          variations: this.getVariations(),
          prisoners: this.getPrisoners(),
          nextColor: this.currentColor,
          canUndo: this.canUndo(),
        },
      })
    );
    return true;
  }

  jumpToNode(id) {
    const target = this.findNodeById(this.rootNode, id);
    if (!target) return false;

    this.currentNode = target;
    this.restoreSnapshot(target.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation("goban-navigate", { moved: 0 });
    return true;
  }

  deleteNode(id) {
    const target = this.findNodeById(this.rootNode, id);
    if (!target || target === this.rootNode || !target.parent) return false;

    const parent = target.parent;
    const index = parent.children.indexOf(target);
    if (index === -1) return false;

    parent.children.splice(index, 1);
    if (this.nodeContains(target, this.currentNode)) {
      this.currentNode = parent;
      this.restoreSnapshot(parent.afterSnapshot);
    }
    this.syncScoringModeWithCurrentNode();
    this.draw();
    this.dispatchNavigation("goban-navigate", { moved: 0 });
    return true;
  }

  nodeContains(root, target) {
    if (root === target) return true;
    return root.children.some((child) => this.nodeContains(child, target));
  }

  findNodeById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = this.findNodeById(child, id);
      if (found) return found;
    }
    return null;
  }

  toSGF() {
    const komi = this.normalizeDecimalText(this.metadata.komi || "0");
    const result = this.normalizeDecimalText(this.metadata.result || "");
    const rootProps = [
      "GM[1]",
      "FF[4]",
      "CA[UTF-8]",
      "AP[ReusableGoban]",
      `SZ[${this.size}]`,
      `KM[${this.sgfEscape(komi)}]`,
      `RU[${this.sgfEscape(this.metadata.rules || "Japanese")}]`,
      result ? `RE[${this.sgfEscape(result)}]` : "",
      this.metadata.blackName ? `PB[${this.sgfEscape(this.metadata.blackName)}]` : "",
      this.metadata.whiteName ? `PW[${this.sgfEscape(this.metadata.whiteName)}]` : "",
      this.metadata.event ? `EV[${this.sgfEscape(this.metadata.event)}]` : "",
      this.metadata.gameName ? `GN[${this.sgfEscape(this.metadata.gameName)}]` : "",
      this.metadata.handicap ? `HA[${this.sgfEscape(this.metadata.handicap)}]` : "",
      this.sgfSetupStones(),
    ].join("");
    return `(;${rootProps}${this.sgfChildren(this.rootNode)})`;
  }

  sgfSetupStones() {
    const setupStones = this.rootNode.afterSnapshot?.stones ?? [];
    const byColor = { black: [], white: [] };
    for (const [key, color] of setupStones) {
      const [x, y] = key.split(",").map(Number);
      if (byColor[color]) byColor[color].push(`[${this.sgfCoord(x, y)}]`);
    }
    return [
      byColor.black.length ? `AB${byColor.black.join("")}` : "",
      byColor.white.length ? `AW${byColor.white.join("")}` : "",
    ].join("");
  }

  setMetadata(metadata = {}) {
    const nextMetadata = { ...metadata };
    if ("komi" in nextMetadata) nextMetadata.komi = this.normalizeDecimalText(nextMetadata.komi);
    if ("result" in nextMetadata) nextMetadata.result = this.normalizeDecimalText(nextMetadata.result);
    this.metadata = { ...this.metadata, ...nextMetadata };
  }

  getMetadata() {
    return { ...this.metadata };
  }

  normalizeDecimalText(value = "") {
    return String(value)
      .replace(/(\d+\.\d*?[1-9])0+\b/g, "$1")
      .replace(/(\d+)\.0+\b/g, "$1");
  }

  loadSGF(text) {
    const tree = this.parseSGF(text);
    const rootProps = tree.nodes[0]?.props ?? {};
    const nextSize = Number.parseInt(rootProps.SZ?.[0], 10);

    this.size = Number.isInteger(nextSize) && nextSize >= 2 ? nextSize : DEFAULT_SIZE;
    this.setAttribute?.("size", String(this.size));
    this.stones.clear();
    this.resetPrisoners();
    this.currentColor = "black";
    this.metadata = {
      blackName: rootProps.PB?.[0] ?? "",
      whiteName: rootProps.PW?.[0] ?? "",
      event: rootProps.EV?.[0] ?? "",
      gameName: rootProps.GN?.[0] ?? "",
      komi: this.normalizeDecimalText(rootProps.KM?.[0] ?? "6.5"),
      result: this.normalizeDecimalText(rootProps.RE?.[0] ?? ""),
      rules: rootProps.RU?.[0] ?? "Japanese",
      handicap: rootProps.HA?.[0] ?? "",
    };
    this.resetGameTree();
    this.applySetupStones(rootProps);
    if (!rootProps.PL?.[0] && Number.parseInt(rootProps.HA?.[0], 10) > 1) this.currentColor = "white";
    this.rootNode.afterSnapshot = this.createSnapshot();

    const mainEnd = this.buildImportedTree(tree, this.rootNode, 1);
    this.currentNode = mainEnd;
    this.restoreSnapshot(this.currentNode.afterSnapshot);
    this.syncScoringModeWithCurrentNode();
    this.draw();

    this.dispatchEvent(
      new CustomEvent("goban-load", {
        bubbles: true,
        composed: true,
        detail: {
          metadata: this.getMetadata(),
          prisoners: this.getPrisoners(),
          nextColor: this.currentColor,
          variations: this.getVariations(),
        },
      })
    );
    return true;
  }

  resetPrisoners() {
    this.prisoners = { black: 0, white: 0 };
  }

  setCurrentColor(color) {
    if (["black", "white"].includes(color)) {
      this.currentColor = color;
      this.draw();
    }
  }

  syncScoringModeWithCurrentNode() {
    // Scoring was intentionally removed; navigation no longer changes modes.
  }

  syncAttributes() {
    const nextSize = Number.parseInt(this.getAttribute("size"), 10);
    this.size = Number.isInteger(nextSize) && nextSize >= 2 ? nextSize : DEFAULT_SIZE;
    const nextStoneStyle = this.getAttribute("stone-style") ?? "classic";
    this.stoneStyle = ["classic", "shell", "flat"].includes(nextStoneStyle) ? nextStoneStyle : "classic";
    this.showCoordinates = this.getAttribute("coordinates") !== "off";
    this.showTargetMarker = this.getAttribute("target-marker") !== "off";
    this.canvas?.setAttribute("aria-label", `${this.size} by ${this.size} Go board`);
  }

  resize() {
    if (!this.isConnected) return;

    const rect = this.getBoundingClientRect();
    const cssSize = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.floor(cssSize * this.pixelRatio);
    this.canvas.height = Math.floor(cssSize * this.pixelRatio);
    this.canvas.style.width = `${cssSize}px`;
    this.canvas.style.height = `${cssSize}px`;
    this.draw();
  }

  metrics() {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const size = Math.min(width, height);
    const margin = size * 0.082;
    const gridSize = size - margin * 2;
    const gap = gridSize / (this.size - 1);
    return { size, margin, gridSize, gap };
  }

  draw() {
    const { size, margin, gap } = this.metrics();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.fillStyle = this.cssVar("--goban-board");
    this.roundRect(ctx, 0, 0, size, size, 8 * this.pixelRatio);
    ctx.fill();

    ctx.save();
    this.applyBoardTransform(ctx, margin, gap);
    ctx.strokeStyle = this.cssVar("--goban-line");
    ctx.lineWidth = Math.max(1, this.pixelRatio);
    ctx.beginPath();
    for (let i = 0; i < this.size; i += 1) {
      const p = margin + i * gap;
      ctx.moveTo(margin, p);
      ctx.lineTo(margin + gap * (this.size - 1), p);
      ctx.moveTo(p, margin);
      ctx.lineTo(p, margin + gap * (this.size - 1));
    }
    ctx.stroke();

    this.drawStarPoints(ctx, margin, gap);
    if (this.showCoordinates) this.drawCoordinates(ctx, margin, gap);
    this.drawHover(ctx, margin, gap);
    this.drawTarget(ctx, margin, gap);
    this.drawStones(ctx, margin, gap);
    this.drawLastMove(ctx, margin, gap);
    ctx.restore();
  }

  applyBoardTransform(ctx, margin, gap) {
    if (this.zoom.scale === 1) return;

    const centerX = margin + this.zoom.center.x * gap;
    const centerY = margin + this.zoom.center.y * gap;
    const canvasCenter = this.metrics().size / 2;
    ctx.translate(canvasCenter, canvasCenter);
    ctx.translate(this.zoom.offsetX, this.zoom.offsetY);
    ctx.scale(this.zoom.scale, this.zoom.scale);
    ctx.translate(-centerX, -centerY);
  }

  drawStarPoints(ctx, margin, gap) {
    const points = STAR_POINTS[this.size] ?? [];
    ctx.fillStyle = this.cssVar("--goban-line");
    for (const x of points) {
      for (const y of points) {
        ctx.beginPath();
        ctx.arc(margin + x * gap, margin + y * gap, gap * 0.11, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawCoordinates(ctx, margin, gap) {
    const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
    const fontSize = Math.max(8 * this.pixelRatio, gap * 0.27);
    const labelColor = this.cssVar("--goban-line");
    const edge = this.metrics().size;
    const topY = margin * 0.43;
    const bottomY = edge - margin * 0.43;
    const leftX = margin * 0.43;
    const rightX = edge - margin * 0.43;

    ctx.save();
    ctx.fillStyle = labelColor;
    ctx.globalAlpha = 0.82;
    ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i < this.size; i += 1) {
      const x = margin + i * gap;
      const y = margin + i * gap;
      const rowLabel = String(this.size - i);
      ctx.fillText(letters[i] ?? String(i + 1), x, topY);
      ctx.fillText(letters[i] ?? String(i + 1), x, bottomY);
      ctx.fillText(rowLabel, leftX, y);
      ctx.fillText(rowLabel, rightX, y);
    }

    ctx.restore();
  }

  drawHover(ctx, margin, gap) {
    if (!this.hoverPoint || this.isInteractionLocked()) return;
    if (this.getStone(this.hoverPoint.x, this.hoverPoint.y)) return;

    ctx.save();
    ctx.globalAlpha = 0.35;
    this.drawStone(ctx, margin, gap, this.hoverPoint.x, this.hoverPoint.y, this.currentColor);
    ctx.restore();
  }

  drawTarget(ctx, margin, gap) {
    const point = this.targetPoint;
    if (!this.showTargetMarker || !point || this.isInteractionLocked()) return;

    const x = margin + point.x * gap;
    const y = margin + point.y * gap;
    const side = gap * 0.78;

    ctx.save();
    ctx.strokeStyle = "#d71920";
    ctx.lineWidth = Math.max(2.5 * this.pixelRatio, gap * 0.08);
    ctx.strokeRect(x - side / 2, y - side / 2, side, side);
    ctx.restore();
  }

  drawStones(ctx, margin, gap) {
    for (const [key, color] of this.stones) {
      const [x, y] = key.split(",").map(Number);
      this.drawStone(ctx, margin, gap, x, y, color);
    }
  }

  drawLastMove(ctx, margin, gap) {
    const move = this.getLastMove();
    if (!move || move.pass) return;

    const cx = margin + move.x * gap;
    const cy = margin + move.y * gap;
    const size = gap * 0.18;

    ctx.save();
    ctx.strokeStyle = "#d71920";
    ctx.lineWidth = Math.max(2 * this.pixelRatio, gap * 0.06);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - size * 1.15, cy);
    ctx.lineTo(cx - size * 0.25, cy + size);
    ctx.lineTo(cx + size * 1.25, cy - size * 1.15);
    ctx.stroke();
    ctx.restore();
  }

  drawStone(ctx, margin, gap, x, y, color) {
    const cx = margin + x * gap;
    const cy = margin + y * gap;
    const radius = gap * (this.stoneStyle === "flat" ? 0.36 : this.stoneStyle === "shell" ? 0.42 : 0.405);

    if (this.stoneStyle === "flat") {
      ctx.fillStyle = color === "black" ? "#070707" : "#fff7e8";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color === "black" ? "#3a3a3a" : "#937f62";
      ctx.lineWidth = Math.max(1.5, this.pixelRatio * 1.25);
      ctx.stroke();
      return;
    }

    const gradient = ctx.createRadialGradient(
      cx - radius * 0.32,
      cy - radius * 0.42,
      radius * 0.15,
      cx,
      cy,
      radius
    );

    if (this.stoneStyle === "shell") {
      if (color === "black") {
        gradient.addColorStop(0, "#a1a1a1");
        gradient.addColorStop(0.22, "#343434");
        gradient.addColorStop(0.72, "#101010");
        gradient.addColorStop(1, "#020202");
      } else {
        gradient.addColorStop(0, "#ffffff");
        gradient.addColorStop(0.46, "#fbf4e6");
        gradient.addColorStop(0.78, "#e1d4bd");
        gradient.addColorStop(1, "#b6a483");
      }
    } else if (color === "black") {
      gradient.addColorStop(0, "#555");
      gradient.addColorStop(0.35, this.cssVar("--goban-black"));
      gradient.addColorStop(1, "#050505");
    } else {
      gradient.addColorStop(0, "#fff");
      gradient.addColorStop(0.72, this.cssVar("--goban-white"));
      gradient.addColorStop(1, "#cfc7b6");
    }

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = color === "black" ? "#000" : "#b5ad9e";
    ctx.lineWidth = Math.max(1, this.pixelRatio);
    ctx.stroke();

    if (this.stoneStyle === "shell") {
      ctx.save();
      ctx.globalAlpha = color === "white" ? 0.32 : 0.22;
      ctx.strokeStyle = color === "white" ? "#9d927f" : "#686868";
      ctx.lineWidth = Math.max(0.75, this.pixelRatio * 0.75);
      for (let i = -3; i <= 3; i += 1) {
        ctx.beginPath();
        ctx.arc(
          cx + i * radius * 0.08,
          cy + radius * 0.08,
          radius * (0.34 + Math.abs(i) * 0.08),
          Math.PI * 1.08,
          Math.PI * 1.92
        );
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  onPointerDown(event) {
    if (this.isInteractionLocked()) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.isPanning = false;
    const point = this.pointFromEvent(event);
    this.targetPoint = point;
    this.hoverPoint = point;

    const now = performance.now();
    if (point && this.lastTap.point && now - this.lastTap.time < 320 && this.distance(point, this.lastTap.point) <= 1) {
      this.toggleZoom(point);
      this.skipNextPlacement = true;
      this.lastTap = { time: 0, point: null };
      this.draw();
      return;
    }

    this.lastTap = { time: now, point };
    this.skipNextPlacement = false;
    this.draw();
  }

  onPointerMove(event) {
    if (this.activePointerId === event.pointerId && this.zoom.scale !== 1 && this.pointerStart) {
      const dx = event.clientX - this.pointerStart.x;
      const dy = event.clientY - this.pointerStart.y;
      if (this.isPanning || Math.hypot(dx, dy) > 12) {
        this.isPanning = true;
        this.zoom.offsetX += dx * this.pixelRatio;
        this.zoom.offsetY += dy * this.pixelRatio;
        this.pointerStart = { x: event.clientX, y: event.clientY };
        this.targetPoint = null;
        this.hoverPoint = null;
        this.clampZoomOffset();
        this.draw();
        return;
      }
    }

    const point = this.pointFromEvent(event);
    this.hoverPoint = point;
    if (this.activePointerId === event.pointerId) {
      this.targetPoint = point;
    }
    this.draw();
  }

  onPointerUp(event) {
    if (this.isInteractionLocked() || this.activePointerId !== event.pointerId) return;
    const point = this.pointFromEvent(event) ?? this.targetPoint;
    this.activePointerId = null;
    this.pointerStart = null;

    if (this.skipNextPlacement) {
      this.skipNextPlacement = false;
      this.targetPoint = null;
      this.draw();
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.targetPoint = null;
      this.draw();
      return;
    }

    this.targetPoint = null;
    this.placeAt(point);
  }

  onPointerLeave() {
    this.activePointerId = null;
    this.pointerStart = null;
    this.isPanning = false;
    this.hoverPoint = null;
    this.targetPoint = null;
    this.draw();
  }

  onKeyDown(event) {
    if (this.isInteractionLocked()) return;
    const center = Math.floor(this.size / 2);
    const active = this.hoverPoint ?? { x: center, y: center };
    const moves = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };

    if (moves[event.key]) {
      const [dx, dy] = moves[event.key];
      this.hoverPoint = {
        x: Math.min(this.size - 1, Math.max(0, active.x + dx)),
        y: Math.min(this.size - 1, Math.max(0, active.y + dy)),
      };
      event.preventDefault();
      this.draw();
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.placeAt(this.hoverPoint ?? active);
    }
  }

  placeAt(point) {
    if (!point) return;

    if (this.getStone(point.x, point.y)) return;

    const color = this.currentColor;
    const event = new CustomEvent("goban-place", {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: { ...point, color },
    });
    this.dispatchEvent(event);

    if (!event.defaultPrevented) {
      const move = this.playMove(point.x, point.y, color);
      if (!move) {
        this.dispatchEvent(
          new CustomEvent("goban-illegal", {
            bubbles: true,
            composed: true,
            detail: { ...point, color, reason: this.lastIllegalReason ?? "illegal" },
          })
        );
        return;
      }

      this.dispatchEvent(
        new CustomEvent("goban-update", {
          bubbles: true,
          composed: true,
          detail: {
            ...point,
            color,
            captured: move.captured,
            prisoners: this.getPrisoners(),
            nextColor: this.currentColor,
            variations: this.getVariations(),
          },
        })
      );
    }
  }

  playPass(color = this.currentColor, options = {}) {
    if (!["black", "white"].includes(color)) return null;
    const reuseExisting = options.reuseExisting !== false;
    const existing = reuseExisting ? this.findExistingMoveChild({ color, pass: true }) : null;
    if (existing) {
      this.currentNode = existing;
      this.restoreSnapshot(existing.afterSnapshot);
      this.syncScoringModeWithCurrentNode();
      this.draw();
      this.dispatchEvent(
        new CustomEvent("goban-update", {
          bubbles: true,
          composed: true,
          detail: {
            color,
            pass: true,
            captured: existing.captured,
            prisoners: this.getPrisoners(),
            nextColor: this.currentColor,
            variations: this.getVariations(),
          },
        })
      );
      return { captured: existing.captured, pass: true, replay: true };
    }

    const previous = this.createSnapshot();
    this.currentColor = this.opponent(color);
    const moveNode = {
      id: ++this.nodeId,
      parent: this.currentNode,
      move: { color, pass: true },
      comment: "",
      captured: [],
      beforeSnapshot: previous,
      afterSnapshot: this.createSnapshot(),
      children: [],
    };
    this.currentNode.children.push(moveNode);
    this.currentNode = moveNode;
    this.draw();
    this.dispatchEvent(
      new CustomEvent("goban-update", {
        bubbles: true,
        composed: true,
        detail: {
          color,
          pass: true,
          captured: [],
          prisoners: this.getPrisoners(),
          nextColor: this.currentColor,
          variations: this.getVariations(),
        },
      })
    );
    return { captured: [], pass: true };
  }

  playMove(x, y, color = this.currentColor, options = {}) {
    this.lastIllegalReason = null;
    if (!this.isOnBoard(x, y) || this.getStone(x, y) || !["black", "white"].includes(color)) {
      this.lastIllegalReason = "illegal";
      return null;
    }

    const reuseExisting = options.reuseExisting !== false;
    const existing = reuseExisting ? this.findExistingMoveChild({ x, y, color }) : null;
    if (existing) {
      this.currentNode = existing;
      this.restoreSnapshot(existing.afterSnapshot);
      this.syncScoringModeWithCurrentNode();
      this.draw();
      return { captured: existing.captured, replay: true };
    }

    const previous = this.createSnapshot();
    const koSnapshot = this.currentNode.parent?.afterSnapshot ?? null;
    const placedKey = this.key(x, y);
    const captured = [];
    const visitedGroups = new Set();
    this.stones.set(placedKey, color);

    for (const neighbor of this.neighbors(x, y)) {
      if (this.getStone(neighbor.x, neighbor.y) !== this.opponent(color)) continue;

      const group = this.collectGroup(neighbor.x, neighbor.y);
      const groupKey = group.stones.map((stone) => this.key(stone.x, stone.y)).sort().join("|");
      if (visitedGroups.has(groupKey)) continue;
      visitedGroups.add(groupKey);

      if (group.liberties.size === 0) {
        for (const stone of group.stones) {
          this.stones.delete(this.key(stone.x, stone.y));
          captured.push({ ...stone, color: this.opponent(color) });
        }
      }
    }

    const ownGroup = this.collectGroup(x, y);
    if (ownGroup.liberties.size === 0) {
      this.restoreSnapshot(previous);
      this.lastIllegalReason = "suicide";
      this.draw();
      return null;
    }

    if (koSnapshot && this.sameStones(koSnapshot.stones, this.stones)) {
      this.restoreSnapshot(previous);
      this.lastIllegalReason = "ko";
      this.draw();
      return null;
    }

    this.prisoners[color] += captured.length;
    this.currentColor = this.opponent(color);
    const moveNode = {
      id: ++this.nodeId,
      parent: this.currentNode,
      move: { x, y, color },
      comment: "",
      captured,
      beforeSnapshot: previous,
      afterSnapshot: this.createSnapshot(),
      children: [],
    };
    this.currentNode.children.push(moveNode);
    this.currentNode = moveNode;
    this.draw();
    return { captured };
  }

  findExistingMoveChild(move) {
    return this.currentNode.children.find((child) => {
      if (!child.move || child.move.color !== move.color) return false;
      if (move.pass) return child.move.pass === true;
      return !child.move.pass && child.move.x === move.x && child.move.y === move.y;
    });
  }

  collectGroup(x, y) {
    const color = this.getStone(x, y);
    const stones = [];
    const liberties = new Set();
    const visited = new Set();
    const queue = [{ x, y }];

    while (queue.length > 0) {
      const point = queue.shift();
      const pointKey = this.key(point.x, point.y);
      if (visited.has(pointKey)) continue;
      visited.add(pointKey);

      if (this.getStone(point.x, point.y) !== color) continue;
      stones.push(point);

      for (const neighbor of this.neighbors(point.x, point.y)) {
        const neighborColor = this.getStone(neighbor.x, neighbor.y);
        if (!neighborColor) {
          liberties.add(this.key(neighbor.x, neighbor.y));
        } else if (neighborColor === color && !visited.has(this.key(neighbor.x, neighbor.y))) {
          queue.push(neighbor);
        }
      }
    }

    return { stones, liberties };
  }

  neighbors(x, y) {
    return [
      { x: x - 1, y },
      { x: x + 1, y },
      { x, y: y - 1 },
      { x, y: y + 1 },
    ].filter((point) => this.isOnBoard(point.x, point.y));
  }

  opponent(color) {
    return color === "black" ? "white" : "black";
  }

  createSnapshot() {
    return {
      stones: [...this.stones.entries()],
      prisoners: this.getPrisoners(),
      currentColor: this.currentColor,
    };
  }

  restoreSnapshot(snapshot) {
    this.stones = new Map(snapshot.stones);
    this.prisoners = { ...snapshot.prisoners };
    this.currentColor = snapshot.currentColor;
  }

  createRootNode() {
    return {
      id: this.nodeId,
      parent: null,
      move: null,
      comment: "",
      captured: [],
      beforeSnapshot: null,
      afterSnapshot: this.createSnapshot(),
      children: [],
    };
  }

  resetGameTree() {
    this.nodeId = 0;
    this.rootNode = this.createRootNode();
    this.currentNode = this.rootNode;
  }

  sgfChildren(node) {
    if (node.children.length === 0) return "";

    if (node.children.length === 1) {
      return this.sgfNode(node.children[0]) + this.sgfChildren(node.children[0]);
    }

    return node.children.map((child) => `(${this.sgfNode(child)}${this.sgfChildren(child)})`).join("");
  }

  sgfNode(node) {
    const color = node.move.color === "black" ? "B" : "W";
    const comment = node.comment ? `C[${this.sgfEscape(node.comment)}]` : "";
    if (node.move.pass) return `;${color}[]${comment}`;
    return `;${color}[${this.sgfCoord(node.move.x, node.move.y)}]${comment}`;
  }

  sgfCoord(x, y) {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return `${letters[x]}${letters[y]}`;
  }

  sgfEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  }

  parseSGF(text) {
    let index = 0;
    const source = String(text);

    const skipSpace = () => {
      while (/\s/.test(source[index])) index += 1;
    };

    const parseTree = () => {
      skipSpace();
      if (source[index] !== "(") throw new Error("Invalid SGF: expected game tree");
      index += 1;
      const nodes = [];
      const children = [];

      while (index < source.length) {
        skipSpace();
        if (source[index] === ";") {
          nodes.push(parseNode());
        } else if (source[index] === "(") {
          children.push(parseTree());
        } else if (source[index] === ")") {
          index += 1;
          return { nodes, children };
        } else {
          index += 1;
        }
      }

      throw new Error("Invalid SGF: unclosed game tree");
    };

    const parseNode = () => {
      index += 1;
      const props = {};
      while (index < source.length) {
        skipSpace();
        if (!/[A-Za-z]/.test(source[index])) break;

        let ident = "";
        while (/[A-Za-z]/.test(source[index])) {
          ident += source[index];
          index += 1;
        }

        props[ident] = props[ident] ?? [];
        skipSpace();
        while (source[index] === "[") {
          index += 1;
          let value = "";
          while (index < source.length) {
            const char = source[index];
            index += 1;
            if (char === "\\") {
              value += source[index] ?? "";
              index += 1;
            } else if (char === "]") {
              break;
            } else {
              value += char;
            }
          }
          props[ident].push(value);
          skipSpace();
        }
      }
      return { props };
    };

    return parseTree();
  }

  buildImportedTree(tree, parent, startIndex = 0) {
    let cursor = parent;
    for (let i = startIndex; i < tree.nodes.length; i += 1) {
      if (this.nodeHasSetupStones(tree.nodes[i])) {
        this.currentNode = cursor;
        this.restoreSnapshot(cursor.afterSnapshot);
        this.applySetupStones(tree.nodes[i].props);
        cursor.afterSnapshot = this.createSnapshot();
        continue;
      }

      const move = this.moveFromSGFNode(tree.nodes[i]);
      if (!move) continue;
      const next = this.appendImportedMove(cursor, move);
      if (next) cursor = next;
    }

    for (const child of tree.children) {
      this.buildImportedTree(child, cursor, 0);
    }

    return cursor;
  }

  nodeHasSetupStones(node) {
    return Boolean(node.props.AB?.length || node.props.AW?.length);
  }

  applySetupStones(props = {}) {
    const apply = (values = [], color) => {
      for (const value of values) {
        if (value.length < 2) continue;
        const x = value.charCodeAt(0) - 97;
        const y = value.charCodeAt(1) - 97;
        if (this.isOnBoard(x, y)) this.stones.set(this.key(x, y), color);
      }
    };

    apply(props.AB, "black");
    apply(props.AW, "white");
    this.currentColor = props.PL?.[0] === "B" ? "black" : props.PL?.[0] === "W" ? "white" : this.currentColor;
  }

  appendImportedMove(parent, move) {
    this.currentNode = parent;
    this.restoreSnapshot(parent.afterSnapshot);
    const result = move.pass
      ? this.playPass(move.color, { reuseExisting: false })
      : this.playMove(move.x, move.y, move.color, { reuseExisting: false });
    if (result && move.comment) this.currentNode.comment = move.comment;
    return result ? this.currentNode : null;
  }

  moveFromSGFNode(node) {
    const black = node.props.B?.[0];
    const white = node.props.W?.[0];
    const value = black ?? white;
    if (value === undefined) return null;
    if (value === "") {
      return {
      color: black !== undefined ? "black" : "white",
      comment: node.props.C?.[0] ?? "",
      pass: true,
      };
    }
    if (value.length < 2) return null;
    return {
      x: value.charCodeAt(0) - 97,
      y: value.charCodeAt(1) - 97,
      color: black !== undefined ? "black" : "white",
      comment: node.props.C?.[0] ?? "",
    };
  }

  sameStones(left, right) {
    return this.stoneSignature(left) === this.stoneSignature(right);
  }

  stoneSignature(stones) {
    const entries = stones instanceof Map ? [...stones.entries()] : stones;
    return entries
      .map(([key, color]) => `${key}:${color}`)
      .sort()
      .join("|");
  }

  pointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    let x = (event.clientX - rect.left) * this.pixelRatio;
    let y = (event.clientY - rect.top) * this.pixelRatio;
    const { margin, gap } = this.metrics();
    if (this.shouldOffsetTouchTarget(event)) {
      y -= gap * 3 * this.zoom.scale;
    }
    if (this.zoom.scale !== 1) {
      const canvasCenter = this.metrics().size / 2;
      const centerX = margin + this.zoom.center.x * gap;
      const centerY = margin + this.zoom.center.y * gap;
      x = (x - canvasCenter - this.zoom.offsetX) / this.zoom.scale + centerX;
      y = (y - canvasCenter - this.zoom.offsetY) / this.zoom.scale + centerY;
    }
    const boardX = Math.round((x - margin) / gap);
    const boardY = Math.round((y - margin) / gap);
    const snapDistance = ["touch", "pen"].includes(event.pointerType) ? gap * 0.74 : gap * 0.48;
    const snappedX = margin + boardX * gap;
    const snappedY = margin + boardY * gap;

    if (!this.isOnBoard(boardX, boardY)) return null;
    if (Math.hypot(x - snappedX, y - snappedY) > snapDistance) return null;
    return { x: boardX, y: boardY };
  }

  shouldOffsetTouchTarget(event) {
    if (!this.showTargetMarker) return false;
    const isTouchLike =
      ["touch", "pen"].includes(event.pointerType) ||
      event.sourceCapabilities?.firesTouchEvents ||
      (navigator.maxTouchPoints > 0 && event.pointerType !== "mouse");
    if (!isTouchLike) return false;
    return true;
  }

  toggleZoom(point) {
    if (this.zoom.scale === 1) {
      this.zoom = { scale: 1.85, center: point, offsetX: 0, offsetY: 0 };
    } else {
      this.zoom = { scale: 1, center: point, offsetX: 0, offsetY: 0 };
    }
  }

  clampZoomOffset() {
    const { size } = this.metrics();
    const limit = (size * (this.zoom.scale - 1)) / 2;
    this.zoom.offsetX = Math.max(-limit, Math.min(limit, this.zoom.offsetX));
    this.zoom.offsetY = Math.max(-limit, Math.min(limit, this.zoom.offsetY));
  }

  distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  isOnBoard(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  key(x, y) {
    return `${x},${y}`;
  }

  cssVar(name) {
    return getComputedStyle(this).getPropertyValue(name).trim();
  }

  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }
}

customElements.define("goban-board", GobanBoard);
