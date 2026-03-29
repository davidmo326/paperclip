import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockControlPlaneService = vi.hoisted(() => ({
  getControlPlane: vi.fn(),
  updateControlPlane: vi.fn(),
  getPortfolio: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  controlPlaneService: () => mockControlPlaneService,
  logActivity: mockLogActivity,
}));

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function createApp(actor = boardActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const fakeProject = {
  id: "project-1",
  companyId: "company-1",
  name: "Test Project",
};

const fakeControlPlane = {
  projectId: "project-1",
  controlPlaneState: {
    portfolioState: "active",
    nextSmallestAction: "Write tests",
    blockerSummary: null,
    lastMeaningfulOutput: "Shipped feature X",
  },
  telemetry: null,
  warnings: [],
};

describe("GET /projects/:id/control-plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with control plane shape", async () => {
    mockProjectService.getById.mockResolvedValue(fakeProject);
    mockControlPlaneService.getControlPlane.mockResolvedValue(fakeControlPlane);

    const res = await request(createApp()).get("/api/projects/project-1/control-plane");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId: "project-1",
      telemetry: null,
      warnings: expect.any(Array),
    });
    expect(res.body.controlPlaneState).toBeDefined();
  });

  it("returns 404 when project not found", async () => {
    mockProjectService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/projects/project-1/control-plane");

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it("returns 403 when actor lacks access to company", async () => {
    const otherProject = { ...fakeProject, companyId: "other-company" };
    mockProjectService.getById.mockResolvedValue(otherProject);

    const res = await request(createApp()).get("/api/projects/project-1/control-plane");

    expect(res.status).toBe(403);
  });
});

describe("PATCH /projects/:id/control-plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with updated state", async () => {
    const updatedResult = {
      ...fakeControlPlane,
      controlPlaneState: {
        ...fakeControlPlane.controlPlaneState,
        portfolioState: "primary",
      },
    };
    mockProjectService.getById.mockResolvedValue(fakeProject);
    mockControlPlaneService.updateControlPlane.mockResolvedValue(updatedResult);

    const res = await request(createApp())
      .patch("/api/projects/project-1/control-plane")
      .send({ portfolioState: "primary" });

    expect(res.status).toBe(200);
    expect(res.body.controlPlaneState.portfolioState).toBe("primary");
    expect(mockControlPlaneService.updateControlPlane).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ portfolioState: "primary" }),
    );
  });

  it("returns 400 when portfolioState is invalid (e.g. 'zombie')", async () => {
    const res = await request(createApp())
      .patch("/api/projects/project-1/control-plane")
      .send({ portfolioState: "zombie" });

    expect(res.status).toBe(400);
  });

  it("does not pass attentionScore to the service (telemetry field rejected by schema)", async () => {
    mockProjectService.getById.mockResolvedValue(fakeProject);
    mockControlPlaneService.updateControlPlane.mockResolvedValue(fakeControlPlane);

    await request(createApp())
      .patch("/api/projects/project-1/control-plane")
      .send({ portfolioState: "active", attentionScore: 99 });

    // updateControlPlane should have been called without attentionScore
    const callArg = mockControlPlaneService.updateControlPlane.mock.calls[0]?.[1];
    expect(callArg).not.toHaveProperty("attentionScore");
  });
});

describe("GET /companies/:companyId/control-plane/portfolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with portfolio shape", async () => {
    const fakePortfolio = {
      companyId: "company-1",
      summary: { primaryCount: 1, activeCount: 2, staleCount: 0, blockedCount: 0 },
      warnings: [],
      projects: [],
    };
    mockControlPlaneService.getPortfolio.mockResolvedValue(fakePortfolio);

    const res = await request(createApp()).get(
      "/api/companies/company-1/control-plane/portfolio",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      summary: expect.any(Object),
      warnings: expect.any(Array),
      projects: expect.any(Array),
    });
  });

  it("returns 403 for unauthorized company", async () => {
    const res = await request(createApp()).get(
      "/api/companies/other-company/control-plane/portfolio",
    );

    expect(res.status).toBe(403);
    expect(mockControlPlaneService.getPortfolio).not.toHaveBeenCalled();
  });
});
