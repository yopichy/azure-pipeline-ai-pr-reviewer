import fetch from "node-fetch";
import { git } from "./git";
import { OpenAIApi } from "openai";
import { addCommentToPR } from "./pr";
import { Agent } from "https";
import * as tl from "azure-pipelines-task-lib/task";

const MAX_TOKENS = 4000; // This is an example. Adjust based on your OpenAI plan.

function countTokens(str: string): number {
  return str.split(/\s+/).length;
}

function truncateContent(content: string, maxTokens: number): string {
  const tokens = content.split(/\s+/);
  return tokens.slice(0, maxTokens).join(" ");
}

/**
 * Deduplicate review text that reasoning models sometimes echo twice.
 * Splits by double-newline into paragraphs, removes exact duplicates
 * while preserving order, and also detects when the entire second half
 * is a repeat of the first half.
 */
function deduplicateReviewText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Strategy 1: check if the text is exactly duplicated (second half = first half)
  const len = trimmed.length;
  const half = Math.floor(len / 2);
  // Find a newline near the midpoint to split cleanly
  for (let offset = 0; offset < Math.min(50, half); offset++) {
    for (const pos of [half + offset, half - offset]) {
      if (pos <= 0 || pos >= len) continue;
      if (trimmed[pos] === "\n") {
        const firstHalf = trimmed.substring(0, pos).trim();
        const secondHalf = trimmed.substring(pos).trim();
        if (firstHalf === secondHalf) {
          return firstHalf;
        }
      }
    }
  }

  // Strategy 2: deduplicate paragraphs (split by blank line)
  const paragraphs = trimmed.split(/\n\s*\n/);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paragraphs) {
    const normalized = p.trim();
    if (!normalized) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  // Strategy 3: deduplicate individual lines (for bullet-style reviews)
  if (unique.length === 1) {
    const lines = trimmed.split("\n");
    const seenLines = new Set<string>();
    const uniqueLines: string[] = [];
    for (const line of lines) {
      const norm = line.trim();
      if (!norm) {
        uniqueLines.push("");
        continue;
      }
      if (!seenLines.has(norm)) {
        seenLines.add(norm);
        uniqueLines.push(line);
      }
    }
    return uniqueLines.join("\n").trim();
  }

  return unique.join("\n\n");
}

function extractReviewFromFoundryResponse(response: any): string | undefined {
  function summarizeFoundryResponseShape(value: any): string {
    try {
      if (!value || typeof value !== "object") {
        return `type=${typeof value}`;
      }

      const status = typeof value.status === "string" ? value.status : undefined;
      const incompleteReason =
        typeof value?.incomplete_details?.reason === "string"
          ? value.incomplete_details.reason
          : undefined;

      const outputLen = Array.isArray(value.output)
        ? value.output.length
        : value.output
          ? 1
          : 0;

      const textType = Array.isArray(value.text)
        ? `array(len=${value.text.length})`
        : typeof value.text;
      const textLen = typeof value.text === "string" ? value.text.length : undefined;

      const firstOutput = Array.isArray(value.output)
        ? value.output[0]
        : value.output;
      const firstOutputKeys =
        firstOutput && typeof firstOutput === "object"
          ? Object.keys(firstOutput).slice(0, 12)
          : [];

      const summaryValue =
        firstOutput && typeof firstOutput === "object" ? (firstOutput as any).summary : undefined;
      const summaryType = Array.isArray(summaryValue)
        ? `array(len=${summaryValue.length})`
        : typeof summaryValue;

      const firstContent =
        firstOutput && typeof firstOutput === "object"
          ? Array.isArray((firstOutput as any).content)
            ? (firstOutput as any).content[0]
            : (firstOutput as any).content
          : undefined;
      const firstContentKeys =
        firstContent && typeof firstContent === "object"
          ? Object.keys(firstContent).slice(0, 12)
          : [];

      return [
        status ? `status=${status}` : undefined,
        incompleteReason ? `incomplete_reason=${incompleteReason}` : undefined,
        `outputLen=${outputLen}`,
        `textType=${textType}`,
        typeof textLen === "number" ? `textLen=${textLen}` : undefined,
        summaryType !== "undefined" ? `firstSummaryType=${summaryType}` : undefined,
        firstOutputKeys.length ? `firstOutputKeys=${firstOutputKeys.join("|")}` : undefined,
        firstContentKeys.length ? `firstContentKeys=${firstContentKeys.join("|")}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    } catch {
      return "(shape unavailable)";
    }
  }

  function extractFromResponsesOutput(output: any): string | undefined {
    const outputItems = Array.isArray(output)
      ? output
      : output
        ? [output]
        : [];

    const textParts: string[] = [];

    for (const item of outputItems) {
      if (!item) {
        continue;
      }

      if (Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          const textCandidate =
            firstText(contentItem?.text) ??
            firstText(contentItem?.output_text) ??
            firstText(contentItem?.value) ??
            firstText(contentItem);

          if (textCandidate?.trim()) {
            textParts.push(textCandidate.trim());
          }
        }
      }

      if (Array.isArray(item.summary)) {
        for (const summaryItem of item.summary) {
          const summaryText =
            (typeof summaryItem?.text === "string" ? summaryItem.text : undefined) ??
            (typeof summaryItem?.text?.value === "string" ? summaryItem.text.value : undefined) ??
            (typeof summaryItem?.value === "string" ? summaryItem.value : undefined);

          if (summaryText?.trim()) {
            textParts.push(summaryText.trim());
          }
        }
      } else if (item.summary) {
        const summaryText = firstText(item.summary);
        if (summaryText?.trim()) {
          textParts.push(summaryText.trim());
        }
      }

      const itemText = firstText(item?.text) ?? firstText(item);
      if (itemText?.trim()) {
        textParts.push(itemText.trim());
      }
    }

    const joined = textParts.join("\n").trim();
    return joined || undefined;
  }

  function extractTextParts(value: any): string[] {
    if (!value) {
      return [];
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }

    if (Array.isArray(value)) {
      const collected: string[] = [];
      for (const item of value) {
        collected.push(...extractTextParts(item));
      }
      return collected;
    }

    if (typeof value !== "object") {
      return [];
    }

    const directFields = [value.text, value.value, value.content, value.output_text, value.message];
    const collected: string[] = [];
    for (const field of directFields) {
      collected.push(...extractTextParts(field));
    }

    return collected;
  }

  function firstText(value: any): string | undefined {
    const joined = extractTextParts(value).join("\n").trim();
    return joined || undefined;
  }

  if (!response) {
    return undefined;
  }

  const outputTextValue = firstText(response.output_text);
  if (outputTextValue) {
    return outputTextValue;
  }

  const topLevelTextValue = firstText(response.text);
  if (topLevelTextValue) {
    return topLevelTextValue;
  }

  const responsesOutputValue = extractFromResponsesOutput(response.output);
  if (responsesOutputValue) {
    return responsesOutputValue;
  }

  if (Array.isArray(response.choices) && response.choices.length > 0) {
    const choiceTextValue = firstText(
      response.choices[0]?.message?.content ??
      response.choices[0]?.text ??
      response.choices[0]
    );
    if (choiceTextValue) {
      return choiceTextValue;
    }
  }

  const outputDirectValue = firstText(response.output);
  if (outputDirectValue) {
    return outputDirectValue;
  }

  const outputItems = Array.isArray(response.output)
    ? response.output
    : response.output
      ? [response.output]
      : [];

  const contents: any[] = [];
  for (const item of outputItems) {
    if (!item) {
      continue;
    }

    if (Array.isArray(item.content)) {
      contents.push(...item.content);
      continue;
    }

    if (item.content) {
      contents.push(item.content);
    }
  }

  const textParts: string[] = [];
  for (const content of contents) {
    const contentTextValue = firstText(content);
    if (contentTextValue) {
      textParts.push(contentTextValue);
    }
  }

  const outputText = textParts.join("\n").trim();

  if (outputText) {
    return outputText;
  }

  const messageValue = firstText(response.message);
  if (messageValue) {
    return messageValue;
  }

  if (typeof response?.status === "string" && response.status !== "completed") {
    console.warn(`Foundry response status: ${response.status}`);
  }
  if (response?.incomplete_details) {
    console.warn(`Foundry incomplete details: ${JSON.stringify(response.incomplete_details)}`);
  }
  console.warn(`Foundry response shape: ${summarizeFoundryResponseShape(response)}`);

  return undefined;
}

function buildAzureChatCompletionsUrl(aoiEndpoint: string, model: string): string {
  try {
    const endpointUrl = new URL(aoiEndpoint);
    const path = endpointUrl.pathname || "/";

    if (path.includes("/openai/deployments/") && path.includes("/chat/completions")) {
      if (!endpointUrl.searchParams.get("api-version")) {
        endpointUrl.searchParams.set("api-version", "2024-12-01-preview");
      }
      return endpointUrl.toString();
    }

    const normalizedPath = path.endsWith("/") ? path : `${path}/`;
    if (normalizedPath === "/") {
      return `${endpointUrl.origin}/openai/deployments/${model}/chat/completions?api-version=2024-12-01-preview`;
    }
  } catch (error) {
    console.warn(`Invalid aoi_endpoint format: ${aoiEndpoint}`);
  }

  return aoiEndpoint;
}

function isOpenAICompatibleV1Endpoint(aoiEndpoint: string): boolean {
  return aoiEndpoint.includes("/openai/v1");
}

function isFoundryModelsChatCompletionsEndpoint(aoiEndpoint: string): boolean {
  return aoiEndpoint.includes("/models/chat/completions");
}

function buildOpenAICompatibleChatCompletionsUrl(aoiEndpoint: string): string {
  try {
    const endpointUrl = new URL(aoiEndpoint);
    const path = endpointUrl.pathname || "/";

    if (path.endsWith("/chat/completions")) {
      return endpointUrl.toString();
    }

    const normalizedPath = path.endsWith("/") ? path : `${path}/`;
    if (normalizedPath.endsWith("/openai/v1/")) {
      return `${endpointUrl.origin}${normalizedPath}chat/completions`;
    }
  } catch (error) {
    console.warn(`Invalid OpenAI-compatible endpoint format: ${aoiEndpoint}`);
  }

  return aoiEndpoint;
}

async function isFileWithIgnoredGitStatus(fileName: string) {
  const fileStatus = await git.status([fileName]);

  return fileStatus.deleted.length > 0;
}

async function fileExistsInBranch(
  branch: string,
  fileName: string
): Promise<boolean> {
  try {
    await git.show([`${branch}:${fileName}`]);
    return true;
  } catch (error) {
    return false;
  }
}

function isFileWithIgnoredFileExtension(
  fileName: string,
  content: string
): boolean {
  const fileExtension = fileName.split(".").pop() || "";
  
  const ignoredExtensions = tl.getInput("file_extensions_to_ignore")?.split(",") || [];
  
  const match = ignoredExtensions.find((x) => x === `.${fileExtension}`);
  if (!!match) {
    console.log(
      `${fileExtension} is ignored. Found match in ignoredExtensions - ${match}.`
    );
    return true;
  }
  return false;
}

export async function reviewFile(
  targetBranch: string,
  fileName: string,
  httpsAgent: Agent,
  apiKey: string,
  openai: OpenAIApi | undefined,
  aoiEndpoint: string | undefined,
  prContext: string
) {
  console.log(`Start reviewing ${fileName} ...`);

  const fileExists = await fileExistsInBranch(targetBranch, fileName);
  
  let fileContent;
  
  if (!fileExists) {
    console.log(
      `${fileName} does not exist in ${targetBranch}. New File.`
    );
    fileContent = await git.show([`HEAD:${fileName}`]);
  } else {
	fileContent = await git.show([`${targetBranch}:${fileName}`]);
  }
  
  const isIgnoredFileExtension = isFileWithIgnoredFileExtension(
    fileName,
    fileContent
  );

  if (isIgnoredFileExtension) {
    console.log(`${fileName} is ignored. Skipping review.`);
    return;
  }

  // const fileStatus = await git.status([fileName]);
  const isIgnoredGitStatus = await isFileWithIgnoredGitStatus(fileName);
  if (isIgnoredGitStatus) {
    console.log(`${fileName} is deleted. Skipping review.`);
    return;
  }

  const defaultOpenAIModel = openai ? "gpt-3.5-turbo" : "gpt-4.1-mini";
  const patch = await git.diff([targetBranch, "--", fileName]);

  const noFeedback = "NF";

  let instructions = `
		Review PR changes in unidiff format and surrounding code context. 
		1. If NO significant issues across ALL categories, respond ONLY with 'NF'. 
		2. ONLY mention a category if there's an issue. DO NOT mention categories with no issues.
		3. Be CONCISE. No fluff. No verbosity.
		4. Rate issues (1-5, 5 highest). Optionally, add an emoji: 'Severity: 3 :emoji:'.
		5. Be CAUTIOUS. Avoid false positives. If unsure, lean towards not flagging.
		6. When suggesting improvements, provide a CODE EXAMPLE for the fix whenever possible.
		Categories:
			1. Code Consistency
			2. Performance
			3. Security
			4. Readability
			5. Error Handling
			6. Compatibility
			7. Best Practices
		Rules for the reviewed code:
			1. Prefer 'if (!!object)' over 'if (object)' - this does not include functions or boolean variables.
			2. Use 'const' for variables that won't be reassigned.
			3. Use early returns to avoid nested 'if' statements.
			4. Descriptive names are clearer than abbreviations.
			5. Avoid magic numbers; use named constants.
			6. Functions/methods should be short and focused on a single task.
			7. Code should explain itself; minimal comments.
		Adhere STRICTLY to the instructions. Prioritize accuracy and precision.
		`;

  const customPrompt = tl.getInput("custom_prompt");
  if (!!customPrompt) {
    if (tl.getBoolInput("override_prompt")) {
      instructions = customPrompt;
    } else {
      instructions = `${customPrompt}\n${instructions}`;
    }
  }

  const model = tl.getInput("model") || defaultOpenAIModel;

  const maxOutputTokensRaw = (tl.getInput("max_output_tokens") || "").trim();
  let maxOutputTokens = Number.parseInt(maxOutputTokensRaw, 10);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    maxOutputTokens = 4096;
  }
  maxOutputTokens = Math.min(Math.max(maxOutputTokens, 1), 20000);

  const reasoningEffortRaw = (tl.getInput("reasoning_effort") || "low").trim().toLowerCase();
  const reasoningEffort = ["low", "medium", "high"].includes(reasoningEffortRaw)
    ? reasoningEffortRaw
    : "low";

  const additionalPrContext = prContext?.trim()
    ? `\n\nAdditional PR context from Azure DevOps:\n${prContext}`
    : "";
  const promptInstructions = `${instructions}${additionalPrContext}`;

  const totalTokens = countTokens(promptInstructions + patch + fileContent);
  console.log(`Total tokens: ${totalTokens}. Max tokens: ${MAX_TOKENS}`);

  // This is just the first version, not sure about the best way to handle this.
  if (totalTokens > MAX_TOKENS) {
    console.warn(
      `Content exceeds token limit by ${
        totalTokens - MAX_TOKENS
      } tokens. Truncating...`
    );
    const newLength = MAX_TOKENS - patch.length - promptInstructions.length - 100;
    console.log(`New length: ${newLength}`);
    fileContent = truncateContent(fileContent, newLength);
  }

  try {
    let reviewText: string | undefined;

    if (openai) {
      const response = await openai.createChatCompletion({
        model: model,
        messages: [
          {
            role: "system",
            content: promptInstructions,
          },
          {
            role: "user",
            content: patch,
          },
          {
            role: "user",
            content: `Surrounding code : ${fileContent}`,
          },
        ],
        max_tokens: maxOutputTokens,
      });

      console.log(
        "Completion tokens: " + response.data.usage?.completion_tokens,
        "Prompt tokens: " + response.data.usage?.prompt_tokens,
        "Total tokens: " + response.data.usage?.total_tokens
      );

      reviewText = extractReviewFromFoundryResponse(response.data);
    } else if (aoiEndpoint) {
      // Check if this is Azure AI Foundry Responses API endpoint
      const isResponsesAPI = aoiEndpoint.includes('/openai/responses');

      if (isResponsesAPI) {
        // Azure AI Foundry Responses API
        console.log(`Responses API request: model=${model}, max_output_tokens=${maxOutputTokens}, reasoning_effort=${reasoningEffort}`);
        const request = await fetch(aoiEndpoint, {
          method: "POST",
          headers: { "api-key": `${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            max_output_tokens: maxOutputTokens,
            reasoning: { effort: reasoningEffort },
            input: `${promptInstructions}\n\nPatch:\n${patch}\n\nSurrounding code:\n${fileContent}`,
          }),
        });

        if (!request.ok) {
          const errorBody = await request.text();
          throw new Error(`Azure Foundry request failed (${request.status}): ${errorBody}`);
        }

        const response = await request.json();
        reviewText = extractReviewFromFoundryResponse(response);
        if (!reviewText || !reviewText.trim()) {
          if (response?.status && response.status !== "completed") {
            console.warn(`Foundry response status: ${response.status}`);
          }
          if (response?.incomplete_details) {
            console.warn(`Foundry incomplete details: ${JSON.stringify(response.incomplete_details)}`);
          }
          console.log(`Foundry response keys: ${Object.keys(response || {}).join(",")}`);
        }
      } else {
        // Azure OpenAI / Foundry Chat Completions API
        const isOpenAICompatible = isOpenAICompatibleV1Endpoint(aoiEndpoint);
        const isFoundryModelsChat = isFoundryModelsChatCompletionsEndpoint(aoiEndpoint);
        const isOpenAIStyleChat = isOpenAICompatible || isFoundryModelsChat;
        const chatCompletionsUrl = isOpenAICompatible
          ? buildOpenAICompatibleChatCompletionsUrl(aoiEndpoint)
          : buildAzureChatCompletionsUrl(aoiEndpoint, model);
        const headers: { [key: string]: string } = {
          "Content-Type": "application/json",
        };

        if (isOpenAICompatible) {
          headers.Authorization = `Bearer ${apiKey}`;
        } else {
          headers["api-key"] = `${apiKey}`;
        }

        const requestBody: any = {
          model: model,
          messages: [
            {
              role: "system",
              content: promptInstructions,
            },
            {
              role: "user",
              content: patch,
            },
            {
              role: "user",
              content: `Surrounding code : ${fileContent}`,
            },
          ],
        };

        if (isOpenAIStyleChat) {
          requestBody.max_tokens = maxOutputTokens;
        } else {
          requestBody.max_completion_tokens = maxOutputTokens;
        }

        const request = await fetch(chatCompletionsUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        });

        if (!request.ok) {
          const errorBody = await request.text();
          throw new Error(`Azure OpenAI request failed (${request.status}): ${errorBody}`);
        }

        const response = await request.json();

        // Diagnostic: log chat completions choice details for debugging
        if (Array.isArray(response?.choices) && response.choices.length > 0) {
          const c0 = response.choices[0];
          const contentVal = c0?.message?.content;
          const contentType = contentVal === null ? "null" : typeof contentVal;
          const contentLen = typeof contentVal === "string" ? contentVal.length : undefined;
          const finishReason = c0?.finish_reason ?? "(none)";
          const contentFilter = c0?.content_filter_results
            ? JSON.stringify(c0.content_filter_results)
            : undefined;
          console.log(
            `Chat choice[0]: finish_reason=${finishReason}, content_type=${contentType}` +
            (typeof contentLen === "number" ? `, content_len=${contentLen}` : "") +
            (contentFilter ? `, content_filter=${contentFilter}` : "")
          );
          // If content is a non-empty string, log a preview (first 200 chars)
          if (typeof contentVal === "string" && contentVal.trim().length > 0) {
            console.log(`Chat content preview: ${contentVal.substring(0, 200)}`);
          }
        } else {
          console.warn(`Chat response has no choices. Keys: ${Object.keys(response || {}).join(",")}`);
        }

        reviewText = extractReviewFromFoundryResponse(response);
        if (!reviewText || !reviewText.trim()) {
          console.log(`Chat response keys: ${Object.keys(response || {}).join(",")}`);
        }
      }
    }

    if (!reviewText || !reviewText.trim()) {
      console.warn(`No review content returned for ${fileName}.`);
    } else {
      // Deduplicate: reasoning models sometimes echo their answer twice
      reviewText = deduplicateReviewText(reviewText);
      console.log(reviewText);

      if (!reviewText.trim().startsWith(noFeedback)) {
        await addCommentToPR(fileName, reviewText, httpsAgent);
      }
    }

    console.log(`Review of ${fileName} completed.`);
  } catch (error: any) {
    if (error.response) {
      console.log(error.response.status);
      console.log(error.response.data);
    } else {
      console.log(error.message);
    }
  }
}