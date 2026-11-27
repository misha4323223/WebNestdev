/**
 * Блок промта про мобильную сборку. Подключается только вместе с инструментами `expo.*`:
 * без них правило «зови expo.build» — инструкция про инструмент, которого у модели нет.
 */
export const MOBILE_TOOL_RULES =
  "A mobile build is not limited by the sandbox network: expo.setup, expo.build and expo.build_status run EAS CLI inside a container with outbound network, so eas-cli downloads itself and uploads the project archive — never tell the user the sandbox has no network for an Expo build, never try to upload the archive through net.request, and never say the build tool was not provided: check expo.status first and use expo.build. " +
  "A build does not need a linked GitHub repository — EAS CLI sends the current project tree (EAS_NO_VCS=1), so \"githubRepository: null\" is not a reason a build cannot start, and \"the archive is too big for an HTTP tool\" is not a platform limit to report either. " +
  "For mobile builds EXPO_TOKEN in the project secrets is a full substitute for the Expo integration card: expo.status, expo.setup and expo.build use it, so never tell the user to connect the Expo card when expo.status reports the token — call expo.status before asking for anything. ";
