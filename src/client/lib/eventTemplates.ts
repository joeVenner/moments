export interface EventTemplate {
  id: "wedding" | "birthday" | "graduation" | "corporate" | "party";
  type: string;
  labelKey: string;
  descriptionKey: string;
  themeKey: string;
  retentionDays: number;
}

export const EVENT_TEMPLATES: EventTemplate[] = [
  { id: "wedding", type: "Wedding", labelKey: "templateWedding", descriptionKey: "templateWeddingDescription", themeKey: "templateWeddingTheme", retentionDays: 90 },
  { id: "birthday", type: "Birthday", labelKey: "templateBirthday", descriptionKey: "templateBirthdayDescription", themeKey: "templateBirthdayTheme", retentionDays: 30 },
  { id: "graduation", type: "Graduation", labelKey: "templateGraduation", descriptionKey: "templateGraduationDescription", themeKey: "templateGraduationTheme", retentionDays: 60 },
  { id: "corporate", type: "Corporate", labelKey: "templateCorporate", descriptionKey: "templateCorporateDescription", themeKey: "templateCorporateTheme", retentionDays: 30 },
  { id: "party", type: "Party", labelKey: "templateParty", descriptionKey: "templatePartyDescription", themeKey: "templatePartyTheme", retentionDays: 14 },
];
