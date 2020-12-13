const express = require("express");
const logfmt = require("logfmt");
const async = require("async");

const router = express.Router();

const makeChunks = (coordinates, splitLimit) => {
  const chunks = [];
  let i,
    j,
    tempArray,
    chunk = splitLimit;
  for (i = 0, j = coordinates.length; i < j; i += chunk) {
    tempArray = coordinates.slice(i, i + chunk);
    chunks.push(tempArray);
  }
  return chunks;
};

router.post("/", (req, res) => {
  if (!req.body.coordinates) {
    return res.status(422).json({ error: "Missing coordinates" });
  }

  const osrm = req.app.get("osrm");
  const options = {
    coordinates: req.body.coordinates,
    sources: req.body.sources,
    destinations: req.body.destinations,
    annotations: req.body.annotations || "distance,duration",
    // Governs what size to break the problem down into
    splitLimit: req.body.splitLimit,
    // How many requests to have in flight at once
    parallelism: req.body.parallelism || 1,
    // Remove sources and destinations in response
    slim: req.body.slim || false,
  };

  if (!req.body.sources || !req.body.destinations) {
    delete options.sources;
    delete options.destinations;
  }

  if (req.body.splitLimit 
    && options.sources.length == 1 
    && req.body.splitLimit < options.coordinates.length ) {
    
    delete req.body.splitLimit;

    // Gather source coordinates
    let sourceCoordinates = options.coordinates[options.sources[0]];

    //  Pop from coordinates
    options.coordinates.splice(options.sources[0], 1);

    // Chunk up coordinates into user defined batches
    const chunks = makeChunks(options.coordinates, options.splitLimit);

    async.mapLimit(
      chunks,
      options.parallelism,
      (chunk, callback) => {
        chunk.unshift(sourceCoordinates);

        const chunkOptions = {
          ...options,
          sources: [0],
          coordinates: chunk
        };
        osrm.table(chunkOptions, (err, result) => {
          if (err) {
            callback(null, result);
          }
          if (chunkOptions.slim) {
            delete result.sources;
            delete result.destinations;
          }
          // postprocess response for 1:N
          if (chunkOptions.idx > 0) {
            result.durations[0].splice(0, 1);
            result.distances[0].splice(0, 1);
          }
          callback(null, result);
        });
      },
      (err, results) => {
        if (err) throw err;

        const mergedResults = {
          distances: [],
          durations: [],
        };

        for (const result of results) {
          const distances = result.distances[0];
          const durations = result.durations[0];
          mergedResults.distances.push(...distances);
          mergedResults.durations.push(...durations);
        }

        return res.json(mergedResults);
      }
    );
  } else {
    try {
      osrm.table(options, (err, result) => {
        if (err) {
          return res.status(422).json({ error: err.message });
        }
        return res.json(result);
      });
    } catch (err) {
      logfmt.error(new Error(err.message));
      return res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
