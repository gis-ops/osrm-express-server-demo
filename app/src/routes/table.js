const express = require("express");
const logfmt = require("logfmt");
const async = require("async");

const router = express.Router();

const range = (start, end) => {
  return Array(end - start + 1).fill().map((_, idx) => start + idx)
}

const doBreakdown = (coordinates, limit, square=false) => {

  const bins = []

  if (!square) {
    for (let x=0; x < coordinates.length; x += limit) {
      let endX = x + limit - 1;
      if (endX > coordinates.length - 1) {
        endX = coordinates.length - 1;
      }
      bins.push({ destinations: range(x, endX) })
    }
  } else {
    for (let x=0; x < coordinates.length; x += limit) {
      let endX = x + limit - 1;
      if (endX > coordinates.length - 1) {
        endX = coordinates.length - 1;
      }
      for (let y=0; y < coordinates.length; y += limit) {
          let endY = y + limit - 1;
          if (endY > coordinates.length - 1) {
            endY = coordinates.length - 1;
          }
          bins.push({ sources: range(x, endX), destinations: range(y, endY) })
      }
    }
  }
  return bins;
}


router.post("/", (req, res) => {
  if (!req.body.coordinates) {
    return res.status(422).json({ error: "Missing coordinates" });
  }

  const osrm = req.app.get("osrm");
  const options = {
    coordinates: req.body.coordinates,
    sources: req.body.sources || [],
    destinations: req.body.destinations || [],
    annotations: req.body.annotations || "distance,duration",
    breakdown: {
      // Governs what size to break the problem down into
      limit: req.body.breakdown ? req.body.breakdown.limit : req.body.coordinates.length,
      // How many requests to have in flight at once
      parallelism: req.body.breakdown ? req.body.breakdown.parallelism : 1,  
    },
    // Strip sources and destinations information from response
    slim: req.body.slim || false,
  };

  if (req.body.breakdown) {

    delete req.body.breakdown
    // one-to-many
    let bins;
    let isSquare = false;
    //console.time("doBreakdown");
    if (options.sources.length == 1) {
      bins = doBreakdown(options.coordinates, options.breakdown.limit);
    // many-to-many
    }  else if ((options.sources.length + options.destinations.length) == 0) {
      isSquare = true;
      bins = doBreakdown(options.coordinates, options.breakdown.limit, isSquare)
    }
    //console.timeEnd("doBreakdown");


    async.mapLimit(
      bins,
      options.breakdown.parallelism,
      (bin, callback) => {

        const payload = {
          ...options,
          sources: bin.sources || [0],
          destinations: bin.destinations
        };

        //console.time("doCall");
        osrm.table(payload, (err, result) => {
          if (err) {
            callback(null, result);
          }
          if (options.slim) {
            delete result.sources;
            delete result.destinations;
          }
          //console.timeEnd("doCall");
          callback(null, { ...result, sources: bin.sources, destinations: bin.destinations, isSquare } );
        });
      },
      (err, results) => {
        if (err) throw err;

        // Set up the durations results array
        const durations = [];
        // Set up the distances results array
        const distances = []
        //console.time("doMerge");
        if (isSquare) {
          for (let i=0; i < options.coordinates.length; i++) durations.push([]);
          for (let i=0; i < options.coordinates.length; i++) distances.push([]);

          for (const matrix of results) {
            const minSourceIdx = Math.min(...matrix.sources)
            const minDestIdx = Math.min(...matrix.destinations)
            for (const sourceIdx of matrix.sources) {
              for (const destinationIdx of matrix.destinations ) {
                durations[sourceIdx][destinationIdx] = matrix.durations[sourceIdx - minSourceIdx][destinationIdx - minDestIdx];
                distances[sourceIdx][destinationIdx] = matrix.distances[sourceIdx - minSourceIdx][destinationIdx - minDestIdx];
              }
            }
          }
        } else {
          for (const matrix of results) {
            const minDestIdx = Math.min(...matrix.destinations)
            for (const destinationIdx of matrix.destinations ) {
              durations[destinationIdx] = matrix.durations[0][destinationIdx - minDestIdx];
              distances[destinationIdx] = matrix.distances[0][destinationIdx - minDestIdx];
            }
          }
        }
        //console.timeEnd("doMerge");

        return res.json({ distances, durations });
      }
    );
  } else {
    try {
      //console.time("doCall");
      osrm.table(options, (err, result) => {
        if (err) {
          return res.status(422).json({ error: err.message });
        }
        //console.timeEnd("doCall");
        return res.json(result);
      });
    } catch (err) {
      logfmt.error(new Error(err.message));
      return res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
