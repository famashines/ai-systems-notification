import type { Migration } from "@famashines/ai-systems-kit/mongo";
import { MongoServerError, type Db } from "mongodb";
import type { Device, Devices, SentEntry, SentLog } from "../application/notify.ts";

export const indexMigration: Migration = {
  name: "001-notification-indexes",
  up: async (db) => {
    await db
      .collection("sent")
      .createIndex({ sentAt: 1 }, { expireAfterSeconds: 30 * 86400 }, undefined);
  },
};

interface DeviceDocument extends Omit<Device, "deviceId"> {
  _id: string;
  registeredAt: Date;
  updatedAt: Date;
}

interface SentDocument extends SentEntry {
  _id: string;
  sentAt: Date;
}

export function mongoDevices(db: Db): Devices {
  const devices = db.collection<DeviceDocument>("devices");
  return {
    all: async () =>
      (await devices.find({}).toArray()).map(({ _id, ownerId, platform, token, locale }) => ({
        deviceId: _id,
        ownerId,
        platform,
        token,
        locale,
      })),
    register: async ({ deviceId, ...device }, now) => {
      await devices.deleteMany({ token: device.token, _id: { $ne: deviceId } });
      const result = await devices.updateOne(
        { _id: deviceId },
        { $set: { ...device, updatedAt: now }, $setOnInsert: { registeredAt: now } },
        { upsert: true },
      );
      return { created: result.upsertedCount === 1 };
    },
    unregister: async (deviceId, ownerId) => {
      await devices.deleteOne({ _id: deviceId, ownerId });
    },
    remove: async (deviceId, token) => {
      await devices.deleteOne({ _id: deviceId, token });
    },
  };
}

const sentId = ({ eventId, deviceId }: SentEntry): string => `${eventId}:${deviceId}`;

export function mongoSent(db: Db): SentLog {
  const sent = db.collection<SentDocument>("sent");
  return {
    claim: async (entry, now) => {
      try {
        await sent.insertOne({ _id: sentId(entry), ...entry, sentAt: now });
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    },
    release: async (entry) => {
      await sent.deleteOne({ _id: sentId(entry) });
    },
  };
}
