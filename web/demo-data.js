// 写し：正本は gas/Alerts.gs（tools/build.cjs が作る。直接直さない）。見本ページだけが使う
window.LB_DEMO = {
 "kinds": {
  "names": {
   "drop": "急に崩れた",
   "klass": "学級でつまずき",
   "stall": "伸びが止まった"
  },
  "labels": {
   "drop": "▼ 急に崩れた",
   "klass": "● 学級でつまずき",
   "stall": "― 伸びが止まった"
  }
 },
 "spec": [
  {
   "path": "drop.accDrop",
   "kind": "drop",
   "label": "正答率の下がり幅（これ以上で出す）",
   "unit": "ポイント",
   "scale": 100,
   "int": false,
   "min": 0.03,
   "max": 0.5,
   "def": 0.15
  },
  {
   "path": "drop.timeRise",
   "kind": "drop",
   "label": "時間の伸び（これ以上で出す）",
   "unit": "倍",
   "scale": 1,
   "int": false,
   "min": 1.05,
   "max": 3,
   "def": 1.25
  },
  {
   "path": "drop.weekMinN",
   "kind": "drop",
   "label": "今週の問題数（これ以上の時だけ）",
   "unit": "問",
   "scale": 1,
   "int": true,
   "min": 1,
   "max": 200,
   "def": 10
  },
  {
   "path": "drop.baseMinN",
   "kind": "drop",
   "label": "前の4週の問題数（これ以上の時だけ）",
   "unit": "問",
   "scale": 1,
   "int": true,
   "min": 1,
   "max": 400,
   "def": 10
  },
  {
   "path": "klass.accBelow",
   "kind": "klass",
   "label": "低いとみなす正答率（これ未満）",
   "unit": "%",
   "scale": 100,
   "int": false,
   "min": 0.3,
   "max": 0.95,
   "def": 0.7
  },
  {
   "path": "klass.share",
   "kind": "klass",
   "label": "低い児童の割合（これ以上で出す）",
   "unit": "%",
   "scale": 100,
   "int": false,
   "min": 0.1,
   "max": 1,
   "def": 0.5
  },
  {
   "path": "klass.minKids",
   "kind": "klass",
   "label": "取り組んだ児童（これ以上の時だけ）",
   "unit": "人",
   "scale": 1,
   "int": true,
   "min": 2,
   "max": 40,
   "def": 5
  },
  {
   "path": "klass.kidMinN",
   "kind": "klass",
   "label": "1人の問題数（これ以上で数に入れる）",
   "unit": "問",
   "scale": 1,
   "int": true,
   "min": 1,
   "max": 200,
   "def": 5
  },
  {
   "path": "stall.minN",
   "kind": "stall",
   "label": "前後4週それぞれの問題数（これ以上の時だけ）",
   "unit": "問",
   "scale": 1,
   "int": true,
   "min": 5,
   "max": 400,
   "def": 20
  },
  {
   "path": "stall.accGain",
   "kind": "stall",
   "label": "正答率の伸び（これ未満なら止まった）",
   "unit": "ポイント",
   "scale": 100,
   "int": false,
   "min": 0,
   "max": 0.3,
   "def": 0.02
  },
  {
   "path": "stall.timeRatio",
   "kind": "stall",
   "label": "時間の比（これより大きければ止まった）",
   "unit": "倍",
   "scale": 1,
   "int": false,
   "min": 0.5,
   "max": 1.2,
   "def": 0.97
  },
  {
   "path": "max",
   "kind": "all",
   "label": "学級ごとに出す数",
   "unit": "件",
   "scale": 1,
   "int": true,
   "min": 1,
   "max": 10,
   "def": 3
  },
  {
   "path": "dismissDays",
   "kind": "all",
   "label": "押した項目を出さない日数",
   "unit": "日",
   "scale": 1,
   "int": true,
   "min": 1,
   "max": 60,
   "def": 14
  }
 ]
};
