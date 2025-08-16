// offscreen에 메시지 보내서 저장소 읽기
function loadRecords() {
  chrome.runtime.sendMessage({ type: "LS_GET" }, (resp) => {
    if (chrome.runtime.lastError) {
      document.getElementById("records").innerText = "에러: " + chrome.runtime.lastError.message;
      return;
    }
    const data = resp || {};
    renderRecords(data);
  });
}

function renderRecords(data) {
  const container = document.getElementById("records");
  container.innerHTML = "";

  if (!Object.keys(data).length) {
    container.innerText = "아직 기록이 없습니다.";
    return;
  }

  // scrollHistory 있으면 특별히 보여주고, 나머지는 JSON으로 출력
  if (data.scrollHistory) {
    for (const [key, value] of Object.entries(data.scrollHistory)) {
      const div = document.createElement("div");
      div.className = "record";
      div.innerHTML = `
        <h2>${key}</h2>
        <pre>${JSON.stringify(value, null, 2)}</pre>
      `;
      container.appendChild(div);
    }
  }

  // scrollHistory 외의 데이터도 표시
  for (const [k, v] of Object.entries(data)) {
    if (k === "scrollHistory") continue;
    const div = document.createElement("div");
    div.className = "record";
    div.innerHTML = `
      <h2>${k}</h2>
      <pre>${JSON.stringify(v, null, 2)}</pre>
    `;
    container.appendChild(div);
  }
}

document.addEventListener("DOMContentLoaded", loadRecords);
