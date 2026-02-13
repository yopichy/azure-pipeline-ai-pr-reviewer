# AI PR Reviewer

A task for Azure DevOps build pipelines to add AI-powered PR reviewer with custom prompt

Streamline your pull request reviews with AI-powered feedback tailored to your needs. Customize review prompts to focus on code quality, best practices, performance optimizations, or other specific criteria. Receive comprehensive insights and actionable suggestions in just a few minutes, empowering you to make faster, more informed decisions.

## Installation

Installation can be done using [Visual Studio MarketPlace](https://marketplace.visualstudio.com/items?itemName=inskyid.AIPrReviewer).

## Usage

Add the tasks to your build definition.

![configure_task](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/blob/main/images/configure_task.png)

## Setup
Hi Trying this

### Give permission to the build service agent

before use this task, make sure that the build service has permissions to contribute to pull requests in your repository :

![contribute_to_pr](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/blob/main/images/contribute_to_pr.png)

### Allow Task to access the system token

#### Yaml pipelines

Add a checkout section with persistCredentials set to true.

```yaml
steps:
  - checkout: self
    persistCredentials: true
```

#### Classic editors

Enable the option "Allow scripts to access the OAuth token" in the "Agent job" properties :

![allow_access_token](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/blob/main/images/allow_access_token.png)

### Azure Open AI service

If you choose to use the Azure Open AI service, you must fill in the endpoint and API key of Azure OpenAI. The format of the endpoint is as follows: https://{XXXXXXXX}.openai.azure.com/openai/deployments/{MODEL_NAME}/chat/completions?api-version={API_VERSION}

### Azure AI Foundry

Azure AI Foundry supports multiple endpoint shapes. Use the one you see in the Foundry portal for your deployment:

1) Responses API (api-key auth)

https://{RESOURCE}.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview

2) OpenAI-compatible endpoint (Bearer auth)

https://{RESOURCE}.services.ai.azure.com/openai/v1/

3) Models Chat Completions endpoint (api-key auth, as shown in some Foundry deployments)

https://{RESOURCE}.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview

Notes:
- Set the task input "Model" to your deployment name (for example: grok-4-fast-reasoning).
- The task detects the endpoint type automatically and applies the correct auth header.
- You can enable/disable PR metadata context with the task option "Use PR title & description as context".

### OpenAI Models

If you leave the Azure endpoint empty, the task uses the OpenAI public API.
If no model is selected, the task defaults to "gpt-3.5-turbo".

### Azure AI Foundry Models

The task dropdown currently includes these Azure AI Foundry model IDs:

- gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
- gpt-5-mini
- Kimi-K2.5
- gpt-5.1, gpt-5.1-chat, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max
- gpt-5.2, gpt-5.2-chat, gpt-5.2-codex
- grok-code-fast-1, grok-3-mini, grok-4-fast-reasoning, grok-4-fast-non-reasoning

## Contributions

Found and fixed a bug or improved on something? Contributions are welcome! Please target your pull request against the `main` branch or report an issue on [GitHub](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/issues) so someone else can try and implement or fix it.

To build and publish extension yourself.

1. Build AiPrReviewer project `npm run build`
2. Bump version in vss-extension.json and task.json
3. Run `tfx extension create --manifest-globs vss-extension.json`
4. Upload extension to marketplace https://marketplace.visualstudio.com/manage/

## License

[MIT](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/blob/main/LICENSE)
