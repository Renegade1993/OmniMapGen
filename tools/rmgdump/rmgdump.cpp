/*
 * rmgdump.cpp - the engine's own random map generator, run from a job file.
 *
 * K, 2026-10-01: "wiring up a harness to run mapgens from VCMI with all possible settings, and run our
 * mapgen with those templates mirroring the VCMI-required settings, and then diffing out what varies
 * between the two". The engine has no command line that makes a random map (the client's --testmap
 * loads a finished one; the lobby is the only front end), so this is a small program linked against
 * VCMI_lib that starts the library the way the engine's own test does (test/CVcmiTestConfig.cpp), runs
 * CMapGenerator for each job and saves the .vmap with CMapSaverJson, as test/map/CMapFormatTest.cpp
 * does. It also writes a sidecar of what the engine knows and a finished map does not: each zone's
 * id, type, owner, town type, terrain, size, treasure bands, and the objects that stand in it.
 *
 * Usage: VCMI_rmg.exe <jobs.json> [--deadline <seconds>] [--list-templates]
 * A job: { "out": "path/no/extension", "template": "Jebus Cross", "w": 144, "h": 144, "levels": 1,
 *          "players": 4, "water": 0|1|2 (none, normal, islands), "monsters": -1|0|1 (weak, normal, strong),
 *          "seed": 123 }
 * Writes <out>.vmap and <out>.zones.json; one result line per job on stdout. The process ends by
 * itself after --deadline seconds (default 3000), whatever it is doing.
 */
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// the engine's generator keeps its map and zones private; this tool only reads them after a run
#define private public
#define protected public

#include "StdInc.h"
#include "lib/GameLibrary.h"
#include "lib/VCMIDirs.h"
#include "lib/filesystem/Filesystem.h"
#include "lib/filesystem/CMemoryBuffer.h"
#include "lib/json/JsonNode.h"
#include "lib/mapping/CMap.h"
#include "lib/mapping/MapFormatJson.h"
#include "lib/mapObjects/CGObjectInstance.h"
#include "lib/callback/EditorCallback.h"
#include "lib/rmg/CMapGenOptions.h"
#include "lib/rmg/CMapGenerator.h"
#include "lib/rmg/CRmgTemplate.h"
#include "lib/rmg/CRmgTemplateStorage.h"
#include "lib/rmg/RmgMap.h"
#include "lib/rmg/Zone.h"
#include "lib/rmg/RmgArea.h"
#include "lib/entities/faction/CFaction.h"
#include "lib/CConsoleHandler.h"
#include "lib/logging/CBasicLogConfigurator.h"

VCMI_LIB_USING_NAMESPACE

static std::string readFile(const std::string & path)
{
	std::ifstream in(path, std::ios::binary);
	if(!in)
		throw std::runtime_error("cannot read " + path);
	std::stringstream ss;
	ss << in.rdbuf();
	return ss.str();
}

static std::string esc(const std::string & s)
{
	std::string o;
	for(char c : s)
	{
		if(c == '"' || c == '\\')
			o += '\\';
		if(c == '\n')
			o += "\\n";
		else
			o += c;
	}
	return o;
}

static const char * zoneTypeName(ETemplateZoneType t)
{
	switch(t)
	{
	case ETemplateZoneType::PLAYER_START: return "playerStart";
	case ETemplateZoneType::CPU_START: return "cpuStart";
	case ETemplateZoneType::TREASURE: return "treasure";
	case ETemplateZoneType::JUNCTION: return "junction";
	case ETemplateZoneType::WATER: return "water";
	case ETemplateZoneType::SEALED: return "sealed";
	}
	return "?";
}

static std::string factionName(FactionID f)
{
	if(f.getNum() < 0)
		return "none";
	try
	{
		return f.toEntity(LIBRARY)->getJsonKey();
	}
	catch(...)
	{
		return std::to_string(f.getNum());
	}
}

static void runJob(const JsonNode & job, double & seconds)
{
	auto started = std::chrono::steady_clock::now();
	const std::string out = job["out"].String();
	CMapGenOptions opt;
	opt.setWidth((si32)job["w"].Integer());
	opt.setHeight((si32)job["h"].Integer());
	opt.setLevels(job["levels"].isNull() ? 1 : (int)job["levels"].Integer());
	// The storage is keyed "scope:name", so getTemplate("Jebus Cross") finds nothing, the options then hold no
	// template, and the engine rolls a random one (found 2026-10-01: the first tier-1 grid ran the wrong
	// template on every map). Find the template by its name and hand over the pointer; refuse when absent.
	{
		const CRmgTemplate * wanted = nullptr;
		for(const auto * t : LIBRARY->tplh->getTemplates())
			if(t->getName() == job["template"].String())
				wanted = t;
		if(!wanted)
			throw std::runtime_error("no template named " + job["template"].String());
		opt.setMapTemplate(wanted);
	}
	opt.setHumanOrCpuPlayerCount((si8)job["players"].Integer());
	if(!job["humans"].isNull())
		opt.setHumanOrCpuPlayerCount((si8)job["players"].Integer());
	opt.setWaterContent((EWaterContent::EWaterContent)(job["water"].isNull() ? 0 : job["water"].Integer()));
	// the lobby's three monster buttons are weak, normal and strong, which the engine stores as
	// ZONE_WEAK, ZONE_NORMAL and ZONE_STRONG? No: the lobby sets GLOBAL_WEAK (2), GLOBAL_NORMAL (3),
	// GLOBAL_STRONG (4); "monsters" here is -1, 0, 1 and becomes 2, 3, 4
	const int ms = job["monsters"].isNull() ? 0 : (int)job["monsters"].Integer();
	opt.setMonsterStrength((EMonsterStrength::EMonsterStrength)(ms + 3));
	// the lobby's three road checkboxes (dirt, gravel, cobblestone); a map with none enabled has no road at all
	for(int r = 1; r <= 3; r++)
		opt.setRoadEnabled(RoadId(r), job["roads"].isNull() ? true : job["roads"].Vector().size() >= (size_t)r ? job["roads"].Vector()[r - 1].Bool() : false);
	const int seed = (int)job["seed"].Integer();

	// the objects keep this callback and the saver asks them for things through it (a null one crashed the save)
	EditorCallback cb(nullptr);
	CMapGenerator gen(opt, &cb, seed);
	// generate() empties the zone list when it is done, so a second thread keeps a hold of the zones once they are
	// laid (progress 12 of 30 is the step after genZones) and they stay readable afterwards
	std::map<int, std::shared_ptr<Zone>> zoneSnapshot;
	std::atomic<bool> stopWatch{false};
	std::thread watcher([&] {
		while(!stopWatch)
		{
			if(zoneSnapshot.empty() && gen.get() >= 12)
				for(const auto & kv : gen.map->zones)
					zoneSnapshot.emplace(kv.first, kv.second);
			std::this_thread::sleep_for(std::chrono::milliseconds(1));
		}
	});
	std::unique_ptr<CMap> map;
	try { map = gen.generate(); }
	catch(...) { stopWatch = true; watcher.join(); throw; }
	stopWatch = true;
	watcher.join();
	cb.setMap(map.get());
	map->name.appendRawString("rmgdump");

	CMemoryBuffer buffer;
	{
		CMapSaverJson saver(&buffer);
		saver.saveMap(map);
	}
	{
		std::ofstream f(out + ".vmap", std::ios::binary);
		f.write((const char *)buffer.getBuffer().data(), buffer.getSize());
	}

	// the zone sidecar
	std::map<int, std::map<std::string, int>> objectsByZone;
	for(const auto & o : map->objects)
	{
		if(!o)
			continue;
		int3 pos = o->visitablePos();
		if(!map->isInTheMap(pos))
			pos = o->anchorPos();
		int zid = -1;
		if(pos.x >= 0 && pos.y >= 0 && pos.z >= 0 && pos.x < map->width && pos.y < map->height && pos.z < (int)map->levels()) zid = gen.map->zoneColouring[pos.x][pos.y][pos.z];
		objectsByZone[zid][o->getTypeName() + ":" + o->getSubtypeName()]++;
	}
	std::ofstream z(out + ".zones.json");
	z << "{\"template\":\"" << esc(job["template"].String()) << "\",\"seed\":" << seed << ",\"w\":" << opt.getWidth()
	  << ",\"h\":" << opt.getHeight() << ",\"levels\":" << opt.getLevels();
	// the template the engine really ran, and its own zone ids (a request can be answered with another template)
	if(const auto * used = opt.getMapTemplate())
	{
		z << ",\"templateUsed\":\"" << esc(used->getName()) << "\",\"templateUsedId\":\"" << esc(used->getId()) << "\",\"templateZones\":[";
		bool fz = true;
		for(const auto & tz : used->getZones())
		{
			if(!fz)
				z << ",";
			fz = false;
			z << "{\"id\":" << tz.first << ",\"type\":\"" << zoneTypeName(tz.second->getType()) << "\"}";
		}
		z << "]";
	}
	z << ",\"playersOut\":" << (int)opt.getHumanOrCpuPlayerCount() << ",\"zones\":[";
	bool first = true;
	for(const auto & kv : zoneSnapshot)
	{
		const auto & zone = *kv.second;
		if(!first)
			z << ",";
		first = false;
		z << "{\"id\":" << kv.first << ",\"type\":\"" << zoneTypeName(zone.getType()) << "\"";
		if(zone.getOwner())
			z << ",\"owner\":" << *zone.getOwner();
		z << ",\"townType\":\"" << esc(factionName(zone.townType)) << "\"";
		z << ",\"underground\":" << (zone.pos.z > 0 ? "true" : "false");
		z << ",\"tiles\":" << zone.dArea.getTilesVector().size();
		z << ",\"treasure\":[";
		bool f2 = true;
		for(const auto & t : zone.getTreasureInfo())
		{
			if(!f2)
				z << ",";
			f2 = false;
			z << "{\"min\":" << t.min << ",\"max\":" << t.max << ",\"density\":" << t.density << "}";
		}
		z << "],\"objects\":{";
		bool f3 = true;
		for(const auto & ob : objectsByZone[kv.first])
		{
			if(!f3)
				z << ",";
			f3 = false;
			z << "\"" << esc(ob.first) << "\":" << ob.second;
		}
		z << "}}";
	}
	z << "],\"outsideZones\":{";
	bool f4 = true;
	for(const auto & ob : objectsByZone[-1])
	{
		if(!f4)
			z << ",";
		f4 = false;
		z << "\"" << esc(ob.first) << "\":" << ob.second;
	}
	z << "}}";
	seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
}

int main(int argc, char * argv[])
{
	double deadline = 3000;
	std::string jobsPath;
	bool listTemplates = false, logOn = false;
	for(int i = 1; i < argc; i++)
	{
		std::string a = argv[i];
		if(a == "--deadline" && i + 1 < argc)
			deadline = atof(argv[++i]);
		else if(a == "--log")
			logOn = true;
		else if(a == "--list-templates")
			listTemplates = true;
		else
			jobsPath = a;
	}
	// the hard stop: whatever the generator is doing, the process ends
	std::thread([deadline] {
		std::this_thread::sleep_for(std::chrono::milliseconds((long long)(deadline * 1000)));
		std::fprintf(stdout, "DEADLINE reached after %.0f s\n", deadline);
		std::fflush(stdout);
		std::_Exit(3);
	}).detach();

	try
	{
		// logging only on --log: a run writes megabytes of trace otherwise
		if(logOn)
		{
			CConsoleHandler * consoleHandler = new CConsoleHandler();
			auto * logConfig = new CBasicLogConfigurator(VCMIDirs::get().userLogsPath() / "rmg_log.txt", consoleHandler);
			logConfig->configureDefault();
		}
		LIBRARY = new GameLibrary;
		LIBRARY->initializeFilesystem(false);
		LIBRARY->initializeLibrary();
	}
	catch(const std::exception & e)
	{
		std::fprintf(stdout, "INIT FAILED: %s\n", e.what());
		std::fflush(stdout);
		return 4;
	}
	std::fprintf(stdout, "library ready\n");
	std::fflush(stdout);

	if(listTemplates)
	{
		for(const auto * t : LIBRARY->tplh->getTemplates())
		{
			auto sizes = t->getMapSizes();
			std::string water;
			for(auto w : t->getWaterContentAllowed())
				water += std::to_string((int)w) + ",";
			std::fprintf(stdout, "TEMPLATE\t%s\t%s\t%s\t%s\t%d,%d,%d\t%d,%d,%d\t%s\t%d\n", t->getName().c_str(), t->getId().c_str(),
				t->getPlayers().toString().c_str(), t->getHumanPlayers().toString().c_str(), sizes.first.x, sizes.first.y, sizes.first.z,
				sizes.second.x, sizes.second.y, sizes.second.z, water.c_str(), (int)t->getZones().size());
			std::fflush(stdout);
		}
		return 0;
	}
	if(jobsPath.empty())
	{
		std::fprintf(stderr, "usage: rmgdump <jobs.json> [--deadline s] [--list-templates]\n");
		return 2;
	}
	std::string text = readFile(jobsPath);
	JsonNode jobs(reinterpret_cast<const std::byte *>(text.data()), text.size(), "jobs");
	int ok = 0, bad = 0;
	for(const auto & job : jobs.Vector())
	{
		double seconds = 0;
		try
		{
			runJob(job, seconds);
			ok++;
			std::fprintf(stdout, "OK\t%s\t%.1f s\n", job["out"].String().c_str(), seconds);
		}
		catch(const std::exception & e)
		{
			bad++;
			std::fprintf(stdout, "FAIL\t%s\t%s\n", job["out"].String().c_str(), e.what());
		}
		catch(...)
		{
			bad++;
			std::fprintf(stdout, "FAIL\t%s\tunknown\n", job["out"].String().c_str());
		}
		std::fflush(stdout);
	}
	std::fprintf(stdout, "DONE ok=%d fail=%d\n", ok, bad);
	std::fflush(stdout);
	std::_Exit(bad ? 1 : 0);
}
