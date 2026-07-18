"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { ChatView } from "@/components/ChatView";
import { CoachSidebar } from "@/components/CoachSidebar";
import { CoverageSidebar } from "@/components/CoverageSidebar";
import { HistoryDrawer } from "@/components/HistoryDrawer";
import { UploadBook } from "@/components/UploadBook";
import { ConnectionSettings } from "@/components/ConnectionSettings";
import { AuditPicker, AuditView } from "@/components/AuditPanel";
import { Controls } from "@/components/Controls";
import { useSession } from "@/components/useSession";
import { AUDIT_DIMENSIONS } from "@/components/types";
import type { BookSummary } from "@/components/types";

export default function Page() {
  const s = useSession();
  const [showCoach, setShowCoach] = useState<boolean>(false);
  const [showCoverage, setShowCoverage] = useState<boolean>(true);
  const [coachTab, setCoachTab] = useState<"teacher" | "learner">("teacher");
  const [showRunInfo, setShowRunInfo] = useState<boolean>(false);

  const canShowCoach =
    s.coachEnabled ||
    s.learnerCoachEnabled ||
    s.coachHistory.length > 0 ||
    s.learnerCoachHistory.length > 0;
  const showSidebar = showCoach && canShowCoach;
  const showCoverageSidebar = showCoverage;

  return (
    <main className="app-main" style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px" }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>教·学·审 观察台</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 12 }}>
          让两个 AI（老师 + 学生）拿你的书上一节课，你在旁边看、并给书打分。知识点覆盖不到的、教师讲不到的，都是你的书要调整的地方。
        </p>
      </header>

      {s.health && !s.health.configured && (
        <div
          style={{
            padding: "12px 14px",
            marginBottom: 12,
            border: "1px solid var(--accent)",
            borderRadius: 8,
            background: "var(--panel)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13 }}>
            👋 第一步：先配置大模型接口（BASE_URL / API Key / 模型），才能开始跑课。
          </span>
          <button className="primary" onClick={() => s.setShowConfig(true)}>
            去配置连接
          </button>
        </div>
      )}

      {s.notice && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 13,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--panel)",
            color: "var(--muted)",
          }}
        >
          ⏳ {s.notice}
        </div>
      )}

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
        onUpload={() => s.setShowUpload(true)}
        onConfig={() => s.setShowConfig(true)}
        healthConfigured={s.health ? s.health.configured : null}
        batchMode={s.batchMode}
        onBatchMode={s.setBatchMode}
        selectedLearners={s.selectedLearners}
        onToggleLearner={s.toggleLearner}
        selectedPacings={s.selectedPacings}
        onTogglePacing={s.togglePacing}
        batchRunning={s.batchRunning}
        onRunBatch={s.runBatch}
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

      {s.batchRuns.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 12,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <div style={{ marginBottom: 6, color: "var(--muted)" }}>
            批量矩阵 · {s.batchRuns.filter((r) => r.status === "done").length}/{s.batchRuns.length} 完成
            {!s.batchRunning &&
              s.batchRuns.some((r) => r.status === "done") &&
              " —— 点右下角「审计…」对这批会话出统一报告"}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {s.batchRuns.map((r, i) => (
              <span
                key={i}
                title={r.sid}
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  color:
                    r.status === "done"
                      ? "var(--accent)"
                      : r.status === "error"
                        ? "var(--danger)"
                        : r.status === "running"
                          ? "inherit"
                          : "var(--muted)",
                  background: r.status === "running" ? "var(--teacher)" : "transparent",
                }}
              >
                {r.learnerId}·{r.pacing}{" "}
                {r.status === "done"
                  ? "✓"
                  : r.status === "running"
                    ? "…"
                    : r.status === "error"
                      ? "✗"
                      : "·"}
              </span>
            ))}
          </div>
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
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
          fontSize: 12,
          color: "var(--muted)",
          flexWrap: "wrap",
        }}
      >
        <span>侧栏：</span>
        {canShowCoach && (
          <button
            onClick={() => setShowCoach((v) => !v)}
            className={showSidebar ? "primary" : undefined}
            style={{ fontSize: 12, padding: "3px 10px" }}
            title="教师/学生教练每轮的后台分析"
          >
            {showSidebar ? "✓ " : ""}教练分析
          </button>
        )}
        <button
          onClick={() => setShowCoverage((v) => !v)}
          className={showCoverageSidebar ? "primary" : undefined}
          style={{ fontSize: 12, padding: "3px 10px" }}
          title="实时知识点覆盖度标注"
        >
          {showCoverageSidebar ? "✓ " : ""}知识点覆盖
        </button>
      </div>

      <div
        className="workspace"
        data-coach={showSidebar ? "true" : "false"}
        data-coverage={showCoverageSidebar ? "true" : "false"}
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

        <CoverageSidebar
          visible={showCoverageSidebar}
          items={s.coverageItems}
          stats={s.coverageStats}
          onCollapse={() => setShowCoverage(false)}
        />
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
          {s.usage.promptTokens > 0 && (
            <>
              {" · "}¥{s.usage.costCny.toFixed(4)}
              <button
                onClick={() => setShowRunInfo((v) => !v)}
                style={{ marginLeft: 8, fontSize: 11, padding: "1px 8px" }}
                title="token 用量、缓存命中、翻页窗口等运行细节"
              >
                {showRunInfo ? "隐藏运行信息" : "运行信息"}
              </button>
            </>
          )}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {s.sid && !s.running && !s.auditing && (
            <button onClick={() => s.continueSession(6)} title="接着最后一个完整轮次，再跑 6 轮">
              继续对话
            </button>
          )}
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

      {showRunInfo && s.usage.promptTokens > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--muted)",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span>输入 token：{s.usage.promptTokens}</span>
          <span>输出 token：{s.usage.completionTokens}</span>
          {s.usage.cacheHitTokens > 0 && <span>🟢 缓存命中：{s.usage.cacheHitTokens}</span>}
          {s.usage.cacheMissTokens > 0 && <span>🔴 缓存未命中：{s.usage.cacheMissTokens}</span>}
          <span>估算成本：¥{s.usage.costCny.toFixed(4)}</span>
          {s.windowInfo && s.windowInfo.totalPages > 0 && (
            <span title="教师当前看到的原文范围（自适应翻页）">
              翻页窗口：第 {s.windowInfo.startPage}–{s.windowInfo.endPage} 页 / 共 {s.windowInfo.totalPages} 页
            </span>
          )}
        </div>
      )}

      {s.showAuditPanel && !s.auditing && (
        <AuditPicker
          book={s.currentBookStat}
          currentSid={s.sid}
          sessions={s.existingSessions}
          picked={s.pickedSids}
          onTogglePick={s.togglePick}
          dimension={s.auditDimension}
          onDimension={s.setAuditDimension}
          history={s.auditHistory}
          onViewHistory={s.viewAudit}
          onCancel={() => s.setShowAuditPanel(false)}
          onSubmit={(sampleName?: string) => s.runAudit(Array.from(s.pickedSids), s.auditDimension, sampleName)}
          checklistStatus={s.checklistStatus}
          generatingSections={s.generatingSections}
          onGenerateChecklist={s.generateChecklist}
          currentAuditId={s.currentAuditId}
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
            <span>
              审计报告 · {AUDIT_DIMENSIONS.find(x => x.id === s.auditDimension)?.label ?? s.auditDimension}
              {s.auditing && "（生成中…）"}
              {s.currentAuditId && (
                <button
                  onClick={() => navigator.clipboard?.writeText(s.currentAuditId)}
                  title="点击复制审计编号"
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    padding: "1px 8px",
                    fontFamily: "monospace",
                    color: "var(--accent)",
                  }}
                >
                  #{s.currentAuditId} ⧉
                </button>
              )}
            </span>
            {!s.auditing && (
              <span style={{ display: "flex", gap: 8 }}>
                <button onClick={s.reopenAudit}>重开一次</button>
                <button onClick={s.closeAudit} title="收起当前报告（不删除已保存的报告）">关闭报告</button>
              </span>
            )}
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

      {s.showUpload && (
        <UploadBook
          onClose={() => s.setShowUpload(false)}
          onImported={(slug) => {
            s.setShowUpload(false);
            void s.refreshBooks(slug);
          }}
        />
      )}

      {s.showConfig && (
        <ConnectionSettings
          onClose={() => s.setShowConfig(false)}
          onSaved={() => void s.refreshHealth()}
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

