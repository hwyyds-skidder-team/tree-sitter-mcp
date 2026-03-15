import path from "node:path";
import { z } from "zod";

export const SupportedLanguageSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  grammarName: z.string(),
  extensions: z.array(z.string()),
  queryTypes: z.array(z.string()),
});

export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export interface RegisteredLanguage extends SupportedLanguage {
  parserLanguage: unknown;
}

export interface LanguageRegistry {
  register(language: RegisteredLanguage): void;
  getById(languageId: string): RegisteredLanguage | undefined;
  getByExtension(extension: string): RegisteredLanguage | undefined;
  getByFilePath(filePath: string): RegisteredLanguage | undefined;
  list(): SupportedLanguage[];
}

export function createLanguageRegistry(): LanguageRegistry {
  const languagesById = new Map<string, RegisteredLanguage>();
  const languagesByExtension = new Map<string, RegisteredLanguage>();

  return {
    register(language: RegisteredLanguage): void {
      if (languagesById.has(language.id)) {
        throw new Error(`Language is already registered: ${language.id}`);
      }

      const normalizedExtensions = language.extensions.map((extension) => extension.toLowerCase());
      const normalizedLanguage: RegisteredLanguage = {
        ...language,
        extensions: normalizedExtensions,
        queryTypes: [...language.queryTypes],
      };

      languagesById.set(normalizedLanguage.id, normalizedLanguage);

      for (const extension of normalizedExtensions) {
        if (languagesByExtension.has(extension)) {
          throw new Error(`File extension is already registered: ${extension}`);
        }

        languagesByExtension.set(extension, normalizedLanguage);
      }
    },

    getById(languageId: string): RegisteredLanguage | undefined {
      return languagesById.get(languageId);
    },

    getByExtension(extension: string): RegisteredLanguage | undefined {
      return languagesByExtension.get(extension.toLowerCase());
    },

    getByFilePath(filePath: string): RegisteredLanguage | undefined {
      return languagesByExtension.get(path.extname(filePath).toLowerCase());
    },

    list(): SupportedLanguage[] {
      return [...languagesById.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((language) => ({
          id: language.id,
          displayName: language.displayName,
          grammarName: language.grammarName,
          extensions: [...language.extensions],
          queryTypes: [...language.queryTypes],
        }));
    },
  };
}
