import assert from "node:assert/strict";

class MockHTMLElement {
  constructor() {
    this.attributes = new Set();
    this.listeners = new Map();
  }

  attachShadow() {
    this.shadowRoot = {
      innerHTML: "",
      querySelector: () => ({
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getContext: () => ({
          arc() {},
          arcTo() {},
          beginPath() {},
          clearRect() {},
          closePath() {},
          createRadialGradient: () => ({ addColorStop() {} }),
          fill() {},
          fillText() {},
          lineTo() {},
          moveTo() {},
          restore() {},
          save() {},
          stroke() {},
          strokeRect() {},
        }),
      }),
    };
    return this.shadowRoot;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatchEvent(event) {
    event.defaultPrevented = false;
    return true;
  }

  getAttribute() {
    return null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

globalThis.HTMLElement = MockHTMLElement;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.CustomEvent = class {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
};
globalThis.customElements = {
  define(_name, value) {
    globalThis.GobanBoard = value;
  },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#000" });

await import("./goban-board.js");

const board = new globalThis.GobanBoard();
board.canvas.width = 600;
board.canvas.height = 600;

board.setStone(1, 1, "white");
assert.equal(board.playMove(0, 1, "black").captured.length, 0);
assert.equal(board.playMove(1, 0, "black").captured.length, 0);
assert.equal(board.playMove(2, 1, "black").captured.length, 0);

const capture = board.playMove(1, 2, "black");
assert.deepEqual(capture.captured, [{ x: 1, y: 1, color: "white" }]);
assert.equal(board.getStone(1, 1), null);
assert.deepEqual(board.getPrisoners(), { black: 1, white: 0 });
assert.equal(board.canUndo(), true);

assert.equal(board.undo(), true);
assert.equal(board.getStone(1, 1), "white");
assert.equal(board.getStone(1, 2), null);
assert.deepEqual(board.getPrisoners(), { black: 0, white: 0 });

board.clear();
board.setStone(0, 1, "black");
board.setStone(1, 0, "black");

assert.equal(board.playMove(0, 0, "white"), null);
assert.equal(board.getStone(0, 0), null);
assert.deepEqual(board.getPrisoners(), { black: 0, white: 0 });

board.clear();
board.setStones([
  { x: 1, y: 1, color: "black" },
  { x: 0, y: 1, color: "white" },
  { x: 1, y: 0, color: "white" },
  { x: 2, y: 1, color: "white" },
  { x: 0, y: 2, color: "black" },
  { x: 2, y: 2, color: "black" },
  { x: 1, y: 3, color: "black" },
]);

const koCapture = board.playMove(1, 2, "white");
assert.deepEqual(koCapture.captured, [{ x: 1, y: 1, color: "black" }]);
assert.equal(board.getStone(1, 1), null);

assert.equal(board.playMove(1, 1, "black"), null);
assert.equal(board.lastIllegalReason, "ko");
assert.equal(board.getStone(1, 1), null);
assert.equal(board.getStone(1, 2), "white");

assert.notEqual(board.playMove(10, 10, "black"), null);
const koRecapture = board.playMove(1, 1, "black");
assert.deepEqual(koRecapture.captured, [{ x: 1, y: 2, color: "white" }]);
assert.equal(board.getStone(1, 1), "black");
assert.equal(board.getStone(1, 2), null);

board.clear();
assert.notEqual(board.playMove(3, 3, "black"), null);
assert.equal(board.setCurrentComment("This is a strong approach."), true);
assert.notEqual(board.playMove(15, 15, "white"), null);
assert.equal(board.undo(), true);
assert.notEqual(board.playMove(16, 16, "white"), null);

assert.match(board.toSGF(), /SZ\[19\]/);
assert.match(board.toSGF(), /;B\[dd\]/);
assert.match(board.toSGF(), /C\[This is a strong approach\.\]/);
assert.match(board.toSGF(), /\(;W\[pp\]\)\(;W\[qq\]\)/);

board.setMetadata({
  gameName: "Dostluk maçı",
  event: "Smyrna turnuvası",
  blackName: "Ada",
  whiteName: "Mert",
  komi: "7.50",
  result: "W+3.50",
  rules: "Japanese",
});
const exported = board.toSGF();
assert.match(exported, /GN\[Dostluk maçı\]/);
assert.match(exported, /EV\[Smyrna turnuvası\]/);
assert.match(exported, /PB\[Ada\]/);
assert.match(exported, /PW\[Mert\]/);
assert.match(exported, /KM\[7.5\]/);
assert.match(exported, /RE\[W\+3.5\]/);
assert.match(exported, /RU\[Japanese\]/);

const imported = new globalThis.GobanBoard();
imported.canvas.width = 600;
imported.canvas.height = 600;
assert.equal(imported.loadSGF(exported), true);
assert.deepEqual(((m) => ({ blackName: m.blackName, whiteName: m.whiteName, event: m.event, gameName: m.gameName }))(imported.getMetadata()), {
  blackName: "Ada",
  whiteName: "Mert",
  event: "Smyrna turnuvası",
  gameName: "Dostluk maçı",
});
assert.equal(imported.getMetadata().komi, "7.5");
assert.equal(imported.getMetadata().result, "W+3.5");
assert.equal(imported.getMetadata().rules, "Japanese");
assert.match(imported.toSGF(), /\(;W\[pp\]\)\(;W\[qq\]\)/);
assert.match(imported.toSGF(), /C\[This is a strong approach\.\]/);

const navBoard = new globalThis.GobanBoard();
navBoard.canvas.width = 600;
navBoard.canvas.height = 600;
for (let i = 0; i < 25; i += 1) {
  const x = (i * 2) % 19;
  const y = Math.floor((i * 2) / 19) * 2;
  assert.notEqual(navBoard.playMove(x, y, i % 2 === 0 ? "black" : "white"), null);
}
assert.equal(navBoard.getMoveNumber(), 25);
assert.equal(navBoard.getMainLineLength(), 25);
assert.equal(navBoard.jumpBy(-20), true);
assert.equal(navBoard.getMoveNumber(), 5);
assert.equal(navBoard.jumpToStart(), true);
assert.equal(navBoard.getMoveNumber(), 0);
assert.equal(navBoard.jumpBy(20), true);
assert.equal(navBoard.getMoveNumber(), 20);
assert.equal(navBoard.jumpToEnd(), true);
assert.equal(navBoard.getMoveNumber(), 25);
assert.equal(navBoard.getNavigationState().canForward, false);

const reuseBoard = new globalThis.GobanBoard();
reuseBoard.canvas.width = 600;
reuseBoard.canvas.height = 600;
assert.notEqual(reuseBoard.playMove(0, 0, "black"), null);
assert.equal(reuseBoard.stepBackward(1), true);
assert.deepEqual(reuseBoard.playMove(0, 0, "black"), { captured: [], replay: true });
assert.equal(reuseBoard.rootNode.children.length, 1);
assert.equal(reuseBoard.getMoveNumber(), 1);
assert.notEqual(reuseBoard.playMove(1, 0, "white"), null);
const deleteTarget = reuseBoard.currentNode;
assert.equal(reuseBoard.stepBackward(1), true);
assert.notEqual(reuseBoard.playMove(2, 0, "white"), null);
assert.equal(reuseBoard.currentNode.parent.children.length, 2);
assert.equal(reuseBoard.deleteNode(deleteTarget.id), true);
assert.equal(reuseBoard.currentNode.parent.children.length, 1);

const passBoard = new globalThis.GobanBoard();
passBoard.canvas.width = 600;
passBoard.canvas.height = 600;
assert.deepEqual(passBoard.playPass("black"), { captured: [], pass: true });
assert.equal(passBoard.currentColor, "white");
assert.deepEqual(passBoard.playPass("white"), { captured: [], pass: true });
assert.equal(passBoard.currentColor, "black");
assert.match(passBoard.toSGF(), /;B\[\];W\[\]/);
assert.equal(passBoard.undo(), true);
assert.equal(passBoard.stepForward(1), true);

passBoard.clear();
passBoard.setCurrentColor("white");
assert.deepEqual(passBoard.playPass(), { captured: [], pass: true });
assert.deepEqual(passBoard.getLastMove(), { color: "white", pass: true });
assert.equal(passBoard.currentColor, "black");

const importedPass = new globalThis.GobanBoard();
importedPass.canvas.width = 600;
importedPass.canvas.height = 600;
assert.equal(importedPass.loadSGF("(;GM[1]FF[4]SZ[19]KM[6.5];B[];W[])"), true);
assert.equal(importedPass.getMoveNumber(), 2);

const handicapBoard = new globalThis.GobanBoard();
handicapBoard.canvas.width = 600;
handicapBoard.canvas.height = 600;
assert.equal(handicapBoard.loadSGF("(;GM[1]FF[4]SZ[19]HA[4]KM[0.5]AB[dd][pd][dp][pp];W[qq];B[qp])"), true);
assert.equal(handicapBoard.getStone(3, 3), "black");
assert.equal(handicapBoard.getStone(15, 3), "black");
assert.equal(handicapBoard.getStone(3, 15), "black");
assert.equal(handicapBoard.getStone(15, 15), "black");
assert.equal(handicapBoard.getMoveNumber(), 2);
assert.match(handicapBoard.toSGF(), /HA\[4\]/);
assert.match(handicapBoard.toSGF(), /AB\[dd\]\[pd\]\[dp\]\[pp\]/);
assert.equal(handicapBoard.jumpToStart(), true);
assert.equal(handicapBoard.currentColor, "white");

const delayedSetupBoard = new globalThis.GobanBoard();
delayedSetupBoard.canvas.width = 600;
delayedSetupBoard.canvas.height = 600;
assert.equal(delayedSetupBoard.loadSGF("(;GM[1]FF[4]SZ[19]HA[4]KM[0.5];AB[dd][pd][dp][pp];W[qq])"), true);
assert.equal(delayedSetupBoard.getStone(3, 3), "black");
assert.equal(delayedSetupBoard.getStone(15, 3), "black");
assert.equal(delayedSetupBoard.getStone(3, 15), "black");
assert.equal(delayedSetupBoard.getStone(15, 15), "black");
assert.equal(delayedSetupBoard.getMoveNumber(), 1);
assert.equal(delayedSetupBoard.jumpToStart(), true);
assert.equal(delayedSetupBoard.currentColor, "white");

console.log("goban capture tests passed");
