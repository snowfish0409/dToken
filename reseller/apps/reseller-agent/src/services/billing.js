/**
 * dToken 计费服务
 *
 * 核心职责：
 * 1. 根据上游返回的真实 token 用量计算 dToken 费用
 * 2. 所有金额使用 BigInt，避免精度丢失
 * 3. 价格单位：dToken 最小单位；前端/配置显示为 18 decimals 的标准 ERC20 dToken
 *
 * 计费公式：
 *   roundCost = (promptTokens × inputTokenPrice) + (completionTokens × outputTokenPrice)
 */

/**
 * 计算单轮 dToken 费用
 *
 * @param {Object} params
 * @param {number} params.promptTokens - 上游返回的 prompt_tokens
 * @param {number} params.completionTokens - 上游返回的 completion_tokens
 * @param {bigint} params.inputTokenPrice - 每 input token 的 dToken 最小单位价格
 * @param {bigint} params.outputTokenPrice - 每 output token 的 dToken 最小单位价格
 * @param {bigint} params.currentCumulativeSpent - 当前累计消费，dToken 最小单位
 * @returns {{roundCost: bigint, cumulativeSpent: bigint, promptCost: bigint, outputCost: bigint}}
 */
export function calculateRoundCost({
  promptTokens,
  completionTokens,
  inputTokenPrice,
  outputTokenPrice,
  currentCumulativeSpent = 0n,
}) {
  const promptCost = BigInt(Math.max(0, promptTokens)) * inputTokenPrice;
  const outputCost = BigInt(Math.max(0, completionTokens)) * outputTokenPrice;
  const roundCost = promptCost + outputCost;
  const cumulativeSpent = currentCumulativeSpent + roundCost;

  return { roundCost, cumulativeSpent, promptCost, outputCost };
}

/**
 * 检查预算是否足够
 *
 * @param {bigint} cumulativeSpent - 本轮后的累计消费
 * @param {bigint} escrowAmount - 托管总金额
 * @returns {{sufficient: boolean, remaining: bigint, deficit: bigint}}
 */
export function checkBudget(cumulativeSpent, escrowAmount) {
  if (cumulativeSpent > escrowAmount) {
    return {
      sufficient: false,
      remaining: 0n,
      deficit: cumulativeSpent - escrowAmount,
    };
  }
  return {
    sufficient: true,
    remaining: escrowAmount - cumulativeSpent,
    deficit: 0n,
  };
}

/**
 * 估算最小一轮费用（用于预检查）
 * 假设至少消耗 1 个 input token
 *
 * @param {bigint} inputTokenPrice
 * @returns {bigint}
 */
export function estimateMinimumRoundCost(inputTokenPrice) {
  return inputTokenPrice; // 最少 1 个 input token
}
