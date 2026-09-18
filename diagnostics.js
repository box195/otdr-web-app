/**
 * OTDR Automatic Optical Fiber Diagnostic Engine (v6.0 Spec-Aligned)
 * Evaluates Bellcore SR-4731 trace data against Korea Expressway Corporation ITS,
 * Korea National Railway (KR I-02030), and ITU-T G.650.3 / G.652 standards.
 * 
 * Classification Tiers:
 * 1. pass: Normal / Excellent (Splice <= 0.15 dB, Rate <= 0.35 dB/km)
 * 2. splice_warn: Splice Caution (0.15 < Splice <= 0.40 dB, Conn 0.5~1.0 dB, Rate 0.35~0.45 dB/km)
 * 3. splice_risk: Splice Risk (0.40 < Splice < 2.00 dB, Conn 1.0~5.0 dB, Rate 0.45~1.00 dB/km)
 * 4. bending: Macrobending (2.00 dB <= Non-reflective step < 3.00 dB)
 * 5. defect: Severe Defect (Step >= 3.00 dB, Conn >= 5.00 dB, Rate > 1.00 dB/km, Link >= 20 dB)
 * 6. unclassified: Unclassified / Dummy Fiber (< 50m or user-designated)
 */

(function (global) {
  'use strict';

  // Korea Expressway Corporation & National Railway Spec Thresholds (1550nm Single-Mode)
  const THRESHOLDS = {
    // 1. Fusion Splice Loss (융착 접속 손실 - C점)
    MAX_SPLICE_LOSS_PASS: 0.15,        // dB: 시방서 정상 준공 한도 (0.15 dB 이하)
    MAX_SPLICE_LOSS_WARN: 0.40,        // dB: 시방서 절대 한계선 (0.15 ~ 0.40 dB는 접속주의)
    MAX_SPLICE_LOSS_RISK: 2.00,        // dB: 0.40 ~ 2.00 dB는 접속위험 (시방 위반 재시공)

    // 2. Connector Connection Loss (커넥터 접속 손실 - D점)
    MAX_CONNECTOR_LOSS_PASS: 0.50,     // dB: 커넥터 정상 한도
    MAX_CONNECTOR_LOSS_WARN: 1.00,     // dB: 커넥터 주의 한도 (0.50 ~ 1.00 dB)
    MAX_CONNECTOR_LOSS_RISK: 5.00,     // dB: 1.00 ~ 5.00 dB 접속위험, 5.00 dB 이상 치명적 불량

    // 3. Macrobending & Severe Drop (심선 꺾임 / 치명적 단차)
    MACROBEND_MIN_LOSS: 2.00,          // dB: 2.00 dB 이상 비반사 단차 -> 벤딩 시작
    MACROBEND_CRITICAL_LOSS: 3.00,     // dB: 3.00 dB 이상 -> 일반 벤딩 초과 치명적 불량

    // 4. Fiber Attenuation Rate (선로 평균 감쇠 계수 - 1550nm)
    MAX_ATTENUATION_RATE_PASS: 0.35,   // dB/km: 표준 시공 정상 한도
    MAX_ATTENUATION_RATE_WARN: 0.45,   // dB/km: 0.35 ~ 0.45 dB/km 감쇠율 주의
    MAX_ATTENUATION_RATE_CRITICAL: 1.00, // dB/km: 1.00 dB/km 초과 시 감쇠율 파탄 불량

    // 5. Short Fiber Total Loss (2km 미만 구내/단거리)
    MAX_SHORT_TOTAL_LOSS_PASS: 4.5,    // dB: 단거리 정상 한도
    MAX_SHORT_TOTAL_LOSS_DEFECT: 8.0,  // dB: 단거리 과다 손실 불량

    // 6. Optical Transceiver Link Budget (장거리 수신 감도)
    MAX_LINK_TOTAL_LOSS_DEFECT: 20.0,  // dB: 광트랜시버 링크 다운 한계 초과
    MAX_LINK_TOTAL_LOSS_WARN: 12.0     // dB: 간선 선로 총손실 주의 마진
  };

  function analyzeTrace(parsedData) {
    if (!parsedData || !parsedData.summary) {
      return null;
    }

    const summary = parsedData.summary;
    const events = (parsedData.keyEvents && parsedData.keyEvents.events) || [];

    const criticalDefects = [];
    const macrobends = [];
    const riskIssues = [];
    const warningIssues = [];
    const issues = [];
    let highLossSplices = 0;
    let reflectiveCount = 0;

    const fiberLenKm = summary.fiberLengthKm || 0;
    const isShortFiber = fiberLenKm < 2.0;

    // A. Check Dummy / Unconnected Fiber (< 50m with no valid optical propagation)
    if (fiberLenKm < 0.050) {
      return {
        score: 0,
        status: "unclassified",
        overallVerdict: "미분류 (Unclassified)",
        verdictClass: "status-unclassified",
        badgeColor: "#38bdf8",
        lossRateGrade: "광신호 미연결 더미 심선",
        lossRateStatus: "unclassified",
        endOfFiberKm: fiberLenKm,
        macrobends: [],
        highLossSplices: 0,
        reflectiveCount: 0,
        sections: [],
        issues: [{
          type: "DUMMY_FIBER",
          severity: "info",
          title: "광선로 미연결 심선 (더미)",
          description: "입사단 직후 광신호가 전무한 미연결 또는 미사용 예비 심선 파형입니다."
        }],
        standards: THRESHOLDS,
        defects: [],
        warnings: []
      };
    }

    // B. Calculate True Optical Span Loss (Subtracting instrument noise cliff at fiber end)
    let rawTotalLoss = summary.totalLossDb || 0;
    let trueSpanLoss = rawTotalLoss;
    let spanEvents = [];

    // Filter events: strictly within valid span (40m launch zone to fiberLenKm - 60m)
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.isEndOfFiber) continue;
      const dKm = ev.distKm;
      if (dKm >= 0.040 && dKm < (fiberLenKm - 0.060)) {
        spanEvents.push(ev);
      }
    }

    // Identify and subtract termination drop if included in rawTotalLoss
    const endEvent = events.find(e => e.isEndOfFiber);
    let termDrop = (endEvent && endEvent.spliceLoss >= 2.5) ? endEvent.spliceLoss : 0;
    const spanSpliceSum = spanEvents.reduce((sum, e) => sum + Math.max(0, e.spliceLoss), 0);
    const fiberAttenLoss = fiberLenKm * 0.22;
    const calcSpanLoss = Number((spanSpliceSum + fiberAttenLoss).toFixed(2));

    if (termDrop > 0) {
      trueSpanLoss = Math.max(calcSpanLoss, Number((rawTotalLoss - termDrop).toFixed(2)));
    } else if (isShortFiber && rawTotalLoss > 4.5 && spanSpliceSum < 2.0) {
      trueSpanLoss = calcSpanLoss;
    } else if (!isShortFiber && (rawTotalLoss / fiberLenKm) > 0.45 && spanSpliceSum < 3.0) {
      trueSpanLoss = calcSpanLoss;
    } else {
      trueSpanLoss = Math.min(rawTotalLoss, Number((calcSpanLoss + 0.5).toFixed(2)));
    }

    trueSpanLoss = Math.max(0.1, Number(trueSpanLoss.toFixed(2)));
    const trueLossRate = fiberLenKm > 0.05 ? Number((trueSpanLoss / fiberLenKm).toFixed(3)) : 0;

    // C. Internal Events Evaluation
    spanEvents.forEach(ev => {
      const loss = ev.spliceLoss || 0;
      const refl = ev.reflLoss || 0;
      const dKm = ev.distKm;
      const isRefl = ev.isReflective || (refl !== 0 && refl > -55.0);

      if (isRefl) {
        reflectiveCount++;
        // Connector evaluation
        if (loss >= THRESHOLDS.MAX_CONNECTOR_LOSS_RISK) {
          // >= 5.0 dB -> Severe Defect
          criticalDefects.push(`커넥터 폭락 불량 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB >= ${THRESHOLDS.MAX_CONNECTOR_LOSS_RISK} dB)`);
          issues.push({
            type: "CONNECTOR_DEFECT",
            severity: "danger",
            title: `커넥터 폭락 불량 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (5.00 dB 이상 극단적 손실). 단면 파손 또는 완전 오염 점검 필요.`
          });
        } else if (loss > THRESHOLDS.MAX_CONNECTOR_LOSS_WARN) {
          // 1.0 dB ~ 5.0 dB -> Splice Risk
          riskIssues.push(`커넥터 고손실 위험 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB > ${THRESHOLDS.MAX_CONNECTOR_LOSS_WARN} dB)`);
          issues.push({
            type: "CONNECTOR_RISK",
            severity: "danger",
            title: `커넥터 고손실 위험 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (시방서 커넥터 한도 1.00 dB 초과). 단면 클리닝/교체 필요.`
          });
        } else if (loss > THRESHOLDS.MAX_CONNECTOR_LOSS_PASS) {
          // 0.5 dB ~ 1.0 dB -> Splice Caution
          warningIssues.push(`커넥터 손실 주의 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB > ${THRESHOLDS.MAX_CONNECTOR_LOSS_PASS} dB)`);
          issues.push({
            type: "CONNECTOR_WARN",
            severity: "warning",
            title: `커넥터 손실 주의 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (권장치 0.50 dB 초과). 페룰 클리닝 권장.`
          });
        }
      } else {
        // Non-reflective: Fusion splice or Macrobending
        if (loss >= THRESHOLDS.MACROBEND_CRITICAL_LOSS) {
          // >= 3.0 dB -> Severe Defect (일반 벤딩 초과 치명적 급락)
          criticalDefects.push(`비반사 급격 파단 불량 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB >= ${THRESHOLDS.MACROBEND_CRITICAL_LOSS} dB)`);
          issues.push({
            type: "CRITICAL_STEP_DEFECT",
            severity: "danger",
            title: `⚠️ [긴급] 심각한 선로 절손/파단 [${dKm.toFixed(3)} km]`,
            description: `단일 지점 손실 ${loss.toFixed(2)} dB 급락 (신호 50% 이상 소멸). 일반 벤딩을 초과하는 케이블 파단 위험.`
          });
        } else if (loss >= THRESHOLDS.MACROBEND_MIN_LOSS) {
          // 2.0 dB ~ 3.0 dB -> Macrobending
          macrobends.push({
            distKm: dKm,
            lossDb: loss,
            recommendation: `⚠️ ${dKm.toFixed(3)} km 지점 ${loss.toFixed(2)} dB 급격 감쇄. 접속함체 내부 곡률반경 미달(R<30mm) 또는 물리적 꺾임 조치 필요.`
          });
          issues.push({
            type: "MACROBEND",
            severity: "warning",
            title: `광심선 꺾임/벤딩 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (2.00~3.00 dB). 접속함체 내 꺾임 심선 정리 권장.`
          });
        } else if (loss > THRESHOLDS.MAX_SPLICE_LOSS_WARN) {
          // 0.40 dB ~ 2.0 dB -> Splice Risk
          riskIssues.push(`접속 손실 시방 한도 초과 위험 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB > ${THRESHOLDS.MAX_SPLICE_LOSS_WARN} dB)`);
          highLossSplices++;
          issues.push({
            type: "SPLICE_RISK",
            severity: "danger",
            title: `접속 손실 시방 한도 초과 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (시방서 절대 한도 0.40 dB 초과). 재접속 필요.`
          });
        } else if (loss > THRESHOLDS.MAX_SPLICE_LOSS_PASS) {
          // 0.15 dB ~ 0.40 dB -> Splice Caution
          warningIssues.push(`접속 손실 권장 기준 초과 주의 (${dKm.toFixed(3)}km: ${loss.toFixed(2)} dB > ${THRESHOLDS.MAX_SPLICE_LOSS_PASS} dB)`);
          highLossSplices++;
          issues.push({
            type: "SPLICE_WARN",
            severity: "warning",
            title: `접속 손실 기준 초과 주의 [${dKm.toFixed(3)} km]`,
            description: `손실 ${loss.toFixed(2)} dB 발생 (시방서 권장 기준 0.15 dB 초과). 접속 상태 점검 권장.`
          });
        }
      }
    });

    // D. Attenuation Rate & Link Total Loss Evaluation
    let lossRateGrade = "정상 (Pass)";
    let lossRateStatus = "pass";

    if (isShortFiber) {
      if (trueSpanLoss <= THRESHOLDS.MAX_SHORT_TOTAL_LOSS_PASS) {
        lossRateGrade = `구내/단거리 정상 (총손실 ${trueSpanLoss.toFixed(2)} dB <= 4.5 dB)`;
        lossRateStatus = "pass";
      } else if (trueSpanLoss <= THRESHOLDS.MAX_SHORT_TOTAL_LOSS_DEFECT) {
        lossRateGrade = `단거리 주의 (총손실 ${trueSpanLoss.toFixed(2)} dB > 4.5 dB)`;
        lossRateStatus = "warn";
        warningIssues.push(`단거리 선로 손실 주의 (총손실 ${trueSpanLoss.toFixed(2)} dB > 4.5 dB)`);
        issues.push({
          type: "SHORT_LOSS_WARN",
          severity: "warning",
          title: "단거리 구간 손실 다소 높음",
          description: `구내/단거리 회선(${fiberLenKm.toFixed(3)} km)의 순수 손실이 ${trueSpanLoss.toFixed(2)} dB입니다.`
        });
      } else {
        lossRateGrade = `단거리 과다 손실 불량 (총손실 ${trueSpanLoss.toFixed(2)} dB > 8.0 dB)`;
        lossRateStatus = "defect";
        criticalDefects.push(`단거리 선로 과다 손실 불량 (총손실 ${trueSpanLoss.toFixed(2)} dB > 8.0 dB)`);
        issues.push({
          type: "SHORT_LOSS_DEFECT",
          severity: "danger",
          title: "단거리 선로 과다 손실 불량",
          description: `초단거리 선로 내 과다 손실(${trueSpanLoss.toFixed(2)} dB)로 선로 교체 또는 재접속 점검이 필요합니다.`
        });
      }
    } else {
      // Trunk / Long Cable (>= 2.0 km)
      if (trueSpanLoss >= THRESHOLDS.MAX_LINK_TOTAL_LOSS_DEFECT) {
        criticalDefects.push(`수신 감도 한계 초과 불량 (총손실 ${trueSpanLoss.toFixed(2)} dB >= 20.0 dB)`);
        issues.push({
          type: "LINK_DROPOUT_RISK",
          severity: "danger",
          title: "광수신 감도 한계 초과 (총손실 >= 20 dB)",
          description: `총 손실이 ${trueSpanLoss.toFixed(2)} dB에 달하여 광트랜시버 링크 다운 위험이 매우 큽니다.`
        });
      } else if (trueSpanLoss >= THRESHOLDS.MAX_LINK_TOTAL_LOSS_WARN) {
        warningIssues.push(`장거리 선로 총손실 주의 (총손실 ${trueSpanLoss.toFixed(2)} dB >= 12.0 dB)`);
        issues.push({
          type: "LINK_LOSS_WARN",
          severity: "warning",
          title: "선로 총손실 다소 높음 (총손실 >= 12 dB)",
          description: `선로 전체 순수 손실이 ${trueSpanLoss.toFixed(2)} dB로 수신 레벨 마진 점검을 권장합니다.`
        });
      }

      if (trueLossRate <= THRESHOLDS.MAX_ATTENUATION_RATE_PASS) {
        lossRateGrade = `우수 (정상: ${trueLossRate.toFixed(3)} dB/km <= 0.35 dB/km)`;
        lossRateStatus = "pass";
      } else if (trueLossRate <= THRESHOLDS.MAX_ATTENUATION_RATE_WARN) {
        lossRateGrade = `주의 (감쇠율 상회: ${trueLossRate.toFixed(3)} dB/km > 0.35 dB/km)`;
        lossRateStatus = "warn";
        warningIssues.push(`선로 평균 감쇠율 주의 (${trueLossRate.toFixed(2)} dB/km > 0.35 dB/km)`);
        issues.push({
          type: "ATTENUATION_HIGH",
          severity: "warning",
          title: "간선 선로 감쇠율 다소 높음",
          description: `평균 감쇠율이 ${trueLossRate.toFixed(2)} dB/km로 표준 관리치(0.35 dB/km)를 소폭 상회합니다.`
        });
      } else if (trueLossRate <= THRESHOLDS.MAX_ATTENUATION_RATE_CRITICAL) {
        lossRateGrade = `위험 (감쇠율 한도 초과: ${trueLossRate.toFixed(3)} dB/km > 0.45 dB/km)`;
        lossRateStatus = "risk";
        riskIssues.push(`선로 감쇠율 시방 한도 초과 위험 (${trueLossRate.toFixed(2)} dB/km > 0.45 dB/km)`);
        issues.push({
          type: "ATTENUATION_RISK",
          severity: "danger",
          title: "광선로 감쇠율 시방 한도 초과",
          description: `평균 감쇠율이 ${trueLossRate.toFixed(2)} dB/km로 시방서 기준(0.45 dB/km)을 초과합니다.`
        });
      } else {
        lossRateGrade = `파탄 (감쇠율 1.0 dB/km 초과 극심 손실)`;
        lossRateStatus = "defect";
        criticalDefects.push(`선로 감쇠율 파탄 불량 (${trueLossRate.toFixed(2)} dB/km > 1.00 dB/km)`);
        issues.push({
          type: "ATTENUATION_CRITICAL",
          severity: "danger",
          title: "광선로 감쇠율 파탄 불량",
          description: `평균 감쇠율이 ${trueLossRate.toFixed(2)} dB/km에 달하여 정상적인 광통신이 불가능합니다.`
        });
      }
    }

    // E. Determine 5-tier Final Status
    // Priority: defect > bending > splice_risk > splice_warn > pass
    let finalStatus = "pass";
    let overallVerdict = "정상 (Pass)";
    let verdictClass = "status-pass";
    let badgeColor = "#10b981";

    if (criticalDefects.length > 0) {
      finalStatus = "defect";
      overallVerdict = "치명적 불량 (Severe Defect)";
      verdictClass = "status-defect";
      badgeColor = "#ef4444";
    } else if (macrobends.length > 0) {
      finalStatus = "bending";
      overallVerdict = "벤딩 (Bending)";
      verdictClass = "status-bending";
      badgeColor = "#a855f7";
    } else if (riskIssues.length > 0) {
      finalStatus = "splice_risk";
      overallVerdict = "접속위험 (Splice Risk)";
      verdictClass = "status-splice_risk";
      badgeColor = "#f97316";
    } else if (warningIssues.length > 0) {
      finalStatus = "splice_warn";
      overallVerdict = "접속주의 (Splice Caution)";
      verdictClass = "status-splice_warn";
      badgeColor = "#f59e0b";
    }

    // Health Score
    let score = 100;
    score -= criticalDefects.length * 35;
    score -= macrobends.length * 20;
    score -= riskIssues.length * 15;
    score -= warningIssues.length * 5;
    if (score < 0) score = 0;

    return {
      score,
      status: finalStatus,
      overallVerdict,
      verdictClass,
      badgeColor,
      lossRateGrade,
      lossRateStatus,
      endOfFiberKm: Number(fiberLenKm.toFixed(3)),
      trueSpanLoss,
      trueLossRate,
      macrobends,
      highLossSplices,
      reflectiveCount,
      sections: [],
      issues,
      defects: criticalDefects,
      risks: riskIssues,
      warnings: warningIssues,
      standards: THRESHOLDS
    };
  }

  const Diagnostics = {
    analyze: analyzeTrace,
    THRESHOLDS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Diagnostics;
  }
  if (typeof window !== 'undefined') {
    window.Diagnostics = Diagnostics;
  }
  if (typeof global !== 'undefined') {
    global.Diagnostics = Diagnostics;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
