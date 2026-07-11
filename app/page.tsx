"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { ChatView } from "@/components/ChatView";
import { CoachSidebar } from "@/components/CoachSidebar";
import { HistoryDrawer } from "@/components/HistoryDrawer";
import { AuditPicker, AuditView } from "@/components/AuditPanel";
import { Controls } from "@/components/Controls";
import { useSession } from "@/components/useSession";
import type { BookSummary } from "@/components/types";

export default function Page() {
  const s = useSession();
  const [showCoach, setShowCoach] = useState<boolean>(true);
  const [coachTab, setCoachTab] = useState<"teacher" | "learner">("teacher");

  const showSidebar =
    showCoach &&
    (s.coachEnabled ||
      s.learnerCoachEnabled ||
      s.coachHistory.length > 0 ||
      s.learnerCoachHistory.length > 0);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px" }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>教-学 agent 观察台</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 12 }}>
          教师看得到本节原文，学生看不到——学生的困惑就是这本书的困惑。
        </p>
      </header>

      <Controls
        books={s.books}
        bookSlug={s.bookSlug}
        onBookSlug={s.setBookSlug}
        book={s.book}
        currentBookStat={s.currentBookStat}
        sectionId={s.sectionId}
        onSectionId={s.setSectionId}
        learnerId={s.learnerId}
        onLearnerId={s.setLearnerId}
        pacing={s.pacing}
        onPacing={s.setPacing}
        coachEnabled={s.coachEnabled}
        learnerCoachEnabled={s.learnerCoachEnabled}
        onCoachMode={(c, l) => {
          s.setCoachEnabled(c);
          s.setLearnerCoachEnabled(l);
        }}
        maxTurns={s.maxTurns}
        onMaxTurns={s.setMaxTurns}
        running={s.running}
        canStart={s.canStart}
        onStart={() => s.start()}
        onStop={s.stop}
        onHistory={s.openHistory}
      />

      {s.currentBookStat && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 12,
            color: "var(--muted)",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {auditRecommendation(s.currentBookStat)}
        </div>
      )}

      {s.error && (
        <div
          style={{
            padding: 10,
            marginBottom: 12,
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            borderRadius: 6,
            background: "var(--panel)",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {s.error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showSidebar ? "1fr 320px" : "1fr",
          gap: 12,
          height: "calc(100vh - 280px)",
          minHeight: 300,
        }}
      >
        <ChatView
          ref={s.scrollRef}
          messages={s.messages}
          running={s.running}
          maxTurns={s.maxTurns}
          citations={s.citations}
          onCite={s.openSection}
        />

        <CoachSidebar
          visible={showSidebar}
          coachTab={coachTab}
          onTabChange={setCoachTab}
          onCollapse={() => setShowCoach(false)}
          coachHistory={s.coachHistory}
          learnerCoachHistory={s.learnerCoachHistory}
        />
        {(s.coachEnabled || s.learnerCoachEnabled) && !showCoach && (
          <button
            onClick={() => setShowCoach(true)}
            style={{ position: "absolute", right: 20, top: 210, fontSize: 11, padding: "2px 8px" }}
          >
            显示教练
          </button>
        )}
      </div>

      <footer
        style={{
          marginTop: 8,
          fontSize: 12,
          color: "var(--muted)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>
          {s.sid ? `会话 ${s.sid}` : "尚未开始"}
          {s.windowInfo && s.windowInfo.totalPages > 0 && (
            <>
              {" · "}
              <span title="教师当前看到的原文范围（自适应翻页）">
                窗口 页 {s.windowInfo.startPage}–{s.windowInfo.endPage} / {s.windowInfo.totalPages}
              </span>
            </>
          )}
          {s.usage.promptTokens > 0 && (
            <span title="本次会话累计 token 用量与估算成本">
              {" · "}in: {s.usage.promptTokens} · out: {s.usage.completionTokens} · ¥{" "}
              {s.usage.costCny.toFixed(4)}
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {s.sid && !s.running && !s.auditing && (
            <button className="primary" onClick={s.openAuditPanel}>
              审计…
            </button>
          )}
          {s.auditing && (
            <button className="danger" onClick={s.stopAudit}>
              停止审计
            </button>
          )}
          {s.sid && (
            <a
              href={`/api/sessions/${s.sid}`}
              target="_blank"
              style={{ color: "var(--accent)" }}
              rel="noreferrer"
            >
              查看 transcript
            </a>
          )}
        </div>
      </footer>

      {s.showAuditPanel && !s.auditing && !s.auditText && (
        <AuditPicker
          book={s.currentBookStat}
          currentSid={s.sid}
          sessions={s.existingSessions}
          picked={s.pickedSids}
          onTogglePick={s.togglePick}
          onCancel={() => s.setShowAuditPanel(false)}
          onSubmit={() => s.runAudit(Array.from(s.pickedSids))}
        />
      )}

      {(s.auditText || s.auditing) && (
        <section
          ref={s.auditRef}
          style={{
            marginTop: 12,
            maxHeight: 480,
            overflowY: "auto",
            padding: 14,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--muted)",
              marginBottom: 8,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>审计报告{s.auditing && "（生成中…）"}</span>
            {!s.auditing && <button onClick={s.reopenAudit}>重开一次</button>}
          </div>
          <AuditView raw={s.auditText} />
        </section>
      )}

      {s.showHistory && (
        <HistoryDrawer
          items={s.historyItems}
          books={s.books}
          onClose={() => s.setShowHistory(false)}
          onView={(sid) => {
            s.setShowHistory(false);
            s.loadSessionIntoView(sid);
          }}
          onResume={(sid) => {
            s.setShowHistory(false);
            s.start(sid);
          }}
        />
      )}

      {s.modalSection && (
        <Modal onClose={() => s.setModalSection(null)} title={`§${s.modalSection.id} 原文`}>
          <pre
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", margin: 0 }}
          >
            {s.modalSection.text}
          </pre>
        </Modal>
      )}
    </main>
  );
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} 字`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k 字`;
  return `${(n / 10000).toFixed(1)}w 字`;
}

/** 根据书总字数给个推荐范围。启发式，不追求精确。 */
function auditRecommendation(book: BookSummary): string {
  const total = book.totalChars;
  const nSec = book.sectionCount;
  if (total < 20_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 可以每节各跑一次会话，最后合审全书。`;
  }
  if (total < 80_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 建议一次审计覆盖 2-3 节相关内容（例如同一章的三节），审起来性价比较高。`;
  }
  if (total < 200_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 一次审计建议聚焦一节；跨节审计限制在同一章，最多 2-3 节，超出容易过长。`;
  }
  return `全书约 ${formatChars(total)}，${nSec} 节 —— 每次审计只挑一节，或者最多 2 节。合审全书不现实。`;
}
