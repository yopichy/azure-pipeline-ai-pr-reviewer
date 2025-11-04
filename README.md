# AI PR Reviewer

A task for Azure DevOps build pipelines to add AI-powered PR reviewer with custom prompt

Streamline your pull request reviews with AI-powered feedback tailored to your needs. Customize review prompts to focus on code quality, best practices, performance optimizations, or other specific criteria. Receive comprehensive insights and actionable suggestions in just a few minutes, empowering you to make faster, more informed decisions.

## Installation

Installation can be done using [Visual Studio MarketPlace](https://marketplace.visualstudio.com/items?itemName=yopichy.AIPrReviewer).

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

For Azure AI Foundry models (including GPT-5 series and Grok models), use the Responses API endpoint format: https://{XXXXXXXX}.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview

### OpenAI Models

In case you don't use Azure Open AI Service, you can choose which model to use, the supported models are "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat", "gpt-5-pro", "gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-3.5-turbo" and "gpt-3.5-turbo-16k". if no model is selected the "gpt-3.5-turbo" is used.

### Azure AI Foundry Models

When using Azure AI Foundry, you can also use additional models like "grok-code-fast-1" (xAI's fast coding model optimized for agentic coding applications).

## Contributions

Found and fixed a bug or improved on something? Contributions are welcome! Please target your pull request against the `main` branch or report an issue on [GitHub](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/issues) so someone else can try and implement or fix it.

To build and publish extension yourself.

1. Build GPTPullRequestReview project `npm run build`
2. Bump version in vss-extension.json and task.json
3. Run `npx tfx-cli extension create`
4. Upload extension to marketplace https://marketplace.visualstudio.com/manage/

## License

[MIT](https://github.com/yopichy/azure-pipeline-ai-pr-reviewer/blob/main/LICENSE)
