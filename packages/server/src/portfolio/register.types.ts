import type {
  Amenity,
  Availability,
  BillingBand,
  DisplayStatus,
  MapPin,
  MeterType,
  PropertyType,
  PropertyUse,
  UnitType,
  Utility,
} from '@rent/domain/portfolio';

/** Units per shown status (PR-06): one count for each status, zero included. */
export type StatusCounts = Record<DisplayStatus, number>;

export interface OwnerRef {
  readonly id: string;
  readonly reference: string;
  readonly displayName: string;
}

export interface UnitRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly propertyId: string;
  readonly propertyCode: string;
  readonly propertyName: string;
  readonly blockId: string;
  readonly blockCode: string;
  readonly unitType: UnitType;
  readonly bedrooms: number | null;
  readonly billingBand: BillingBand;
  readonly bandOverridden: boolean;
  readonly availability: Availability;
  readonly status: DisplayStatus;
  readonly underRepair: boolean;
  readonly owner: OwnerRef | null;
  readonly region: string;
  readonly district: string | null;
  readonly archived: boolean;
}

export interface PropertyRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly propertyType: PropertyType;
  readonly use: PropertyUse;
  readonly region: string;
  readonly district: string | null;
  readonly town: string | null;
  readonly owner: OwnerRef | null;
  readonly unitCount: number;
  readonly counts: StatusCounts;
  readonly archived: boolean;
}

export interface PropertyAddress {
  readonly ghanapostGps: string | null;
  readonly region: string;
  readonly district: string | null;
  readonly mmda: string | null;
  readonly town: string | null;
  readonly street: string | null;
  readonly pin: MapPin | null;
  /** "Open in maps" (M2 decision 2); null without a pin. */
  readonly mapsLink: string | null;
  readonly source: 'lookup' | 'manual';
}

export interface OwnershipRow {
  readonly ownerId: string;
  readonly reference: string;
  readonly displayName: string;
  readonly shareBps: number;
  readonly effectiveFrom: string;
  readonly current: boolean;
}

export interface BlockView {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
  readonly isDefault: boolean;
  readonly archived: boolean;
  readonly units: UnitRow[];
}

export interface MeterView {
  readonly id: string;
  readonly utility: Utility;
  readonly supplier: string;
  readonly meterNumber: string;
  readonly meterType: MeterType;
  readonly notes: string | null;
  readonly unitIds: string[];
  readonly archived: boolean;
}

export interface PropertyDetail extends PropertyRow {
  readonly portfolio: { readonly id: string; readonly name: string };
  readonly address: PropertyAddress;
  readonly ownership: OwnershipRow[];
  readonly blocks: BlockView[];
  readonly meters: MeterView[];
  readonly createdAt: Date;
}

export interface StatusEventView {
  readonly id: string;
  readonly kind: 'availability' | 'occupancy';
  readonly fromValue: string | null;
  readonly toValue: string;
  readonly reason: string | null;
  readonly source: 'created' | 'manual' | 'import' | 'lease';
  readonly actorName: string | null;
  readonly occurredAt: Date;
}

export interface UnitDetail extends UnitRow {
  readonly floor: string | null;
  readonly description: string | null;
  readonly amenities: Amenity[];
  readonly bandOverrideReason: string | null;
  readonly meters: MeterView[];
  readonly history: StatusEventView[];
}

export interface UnitFilters {
  readonly ownerId?: string;
  readonly region?: string;
  readonly district?: string;
  readonly propertyId?: string;
  readonly unitType?: UnitType;
  readonly status?: DisplayStatus;
  readonly search?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PropertyFilters {
  readonly ownerId?: string;
  readonly region?: string;
  readonly district?: string;
  readonly propertyType?: PropertyType;
  readonly search?: string;
  readonly includeArchived?: boolean;
}

export interface UnitBatch {
  readonly unitType: UnitType;
  readonly count: number;
  readonly bedrooms?: number | null;
  readonly amenities?: readonly string[];
}

export interface NewBlock {
  readonly code: string;
  readonly name?: string | null;
  readonly units?: readonly UnitBatch[];
}

export interface AddressInput {
  readonly ghanapostGps?: string | null;
  readonly region: string;
  readonly district?: string | null;
  readonly mmda?: string | null;
  readonly town?: string | null;
  readonly street?: string | null;
  readonly latitude?: string | number | null;
  readonly longitude?: string | number | null;
  readonly source?: 'lookup' | 'manual';
}

export interface NewProperty {
  readonly portfolioId?: string | null;
  readonly areaCode: string;
  readonly propertyPart: string;
  readonly name: string;
  readonly propertyType: PropertyType;
  readonly use: PropertyUse;
  /** Required in an agency; a landlord's own owner record otherwise. */
  readonly ownerId?: string | null;
  readonly address: AddressInput;
  /** Without blocks, units go into the default block B1. */
  readonly blocks?: readonly NewBlock[];
  readonly units?: readonly UnitBatch[];
}
