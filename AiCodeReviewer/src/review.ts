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

function extractReviewFromFoundryResponse(response: any): string | undefined {
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

  if (Array.isArray(response.choices) && response.choices.length > 0) {
    const choiceTextValue = firstText(response.choices[0]?.message?.content);
    if (choiceTextValue) {
      return choiceTextValue;
    }
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

  const textValue = firstText(response.text);
  if (textValue) {
    return textValue;
  }

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
  aoiEndpoint: string | undefined
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

  const defaultOpenAIModel = "gpt-3.5-turbo";
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

  const totalTokens = countTokens(instructions + patch + fileContent);
  console.log(`Total tokens: ${totalTokens}. Max tokens: ${MAX_TOKENS}`);

  // This is just the first version, not sure about the best way to handle this.
  if (totalTokens > MAX_TOKENS) {
    console.warn(
      `Content exceeds token limit by ${
        totalTokens - MAX_TOKENS
      } tokens. Truncating...`
    );
    const newLength = MAX_TOKENS - patch.length - instructions.length - 100;
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
            content: instructions,
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
        max_tokens: 750,
      });

      console.log(
        "Completion tokens: " + response.data.usage?.completion_tokens,
        "Prompt tokens: " + response.data.usage?.prompt_tokens,
        "Total tokens: " + response.data.usage?.total_tokens
      );

      reviewText = response.data.choices?.[0]?.message?.content;
    } else if (aoiEndpoint) {
      // Check if this is Azure AI Foundry Responses API endpoint
      const isResponsesAPI = aoiEndpoint.includes('/openai/responses');

      if (isResponsesAPI) {
        // Azure AI Foundry Responses API
        const request = await fetch(aoiEndpoint, {
          method: "POST",
          headers: { "api-key": `${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            max_output_tokens: 750,
            input: `${instructions}\n\nPatch:\n${patch}\n\nSurrounding code:\n${fileContent}`,
          }),
        });

        if (!request.ok) {
          const errorBody = await request.text();
          throw new Error(`Azure Foundry request failed (${request.status}): ${errorBody}`);
        }

        const response = await request.json();
        reviewText = extractReviewFromFoundryResponse(response);
        if (!reviewText || !reviewText.trim()) {
          console.log(`Foundry response keys: ${Object.keys(response || {}).join(",")}`);
        }
      } else {
        // Azure OpenAI / Foundry Chat Completions API
        const isOpenAICompatible = isOpenAICompatibleV1Endpoint(aoiEndpoint);
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

        const request = await fetch(chatCompletionsUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: model,
            max_completion_tokens: 750,
            messages: [
              {
                role: "system",
                content: instructions,
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
          }),
        });

        if (!request.ok) {
          const errorBody = await request.text();
          throw new Error(`Azure OpenAI request failed (${request.status}): ${errorBody}`);
        }

        const response = await request.json();
        reviewText = response?.choices?.[0]?.message?.content;
      }
    }

    if (!reviewText || !reviewText.trim()) {
      console.warn(`No review content returned for ${fileName}.`);
    } else {
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